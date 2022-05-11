import LogController from '../Log/Controller.js'
import getPort from 'get-port'
import * as SocketIO from 'socket.io'
import PQueue from 'p-queue'
import Respawn from 'respawn'
import shortid from 'shortid'
import path from 'path'
import semver from 'semver'
import fs from 'fs-extra'
import SocketEventsHandler from './Wrapper.js'

const moduleBasePkgStr = await fs.readFile(new URL('../../module-base/package.json', import.meta.url))
const moduleBasePkg = JSON.parse(moduleBasePkgStr.toString())
const moduleVersion = semver.parse(moduleBasePkg.version)
const validApiRange = new semver.Range(`${moduleVersion.major} <= ${moduleBasePkg.version}`)

class ModuleHost {
	constructor(registry, instanceStatus) {
		this.logger = LogController.createLogger('Instance/ModuleHost')
		this.registry = registry
		this.instanceStatus = instanceStatus

		this.children = new Map()
	}

	/**
	 * Initialise the module host. Must only be run once
	 * @access public
	 */
	async init() {
		this.socketPort = await getPort()
		this.socketServer = new SocketIO.Server({
			transports: ['websocket'],
			allowEIO3: true,
			cors: {
				origin: `http://localhost:${this.socketPort}`,
				methods: ['GET', 'POST'],
			},
		})
		this.socketServer.listen(this.socketPort)
		this.logger.verbose(`listening on port: ${this.socketPort}`)

		this.socketServer.on('connection', (socket) => {
			this.logger.debug('A module connected')
			this.#listenToModuleSocket(socket)
		})
	}

	/**
	 * Bind events/initialise a connected child process
	 * @param {SocketIO.Client} socket
	 */
	#listenToModuleSocket(socket) {
		socket.once('register', (apiVersion, connectionId, token, cb) => {
			if (!validApiRange.test(apiVersion)) {
				this.logger.debug(`Got register for unsupported api version "${apiVersion}" connectionId: "${connectionId}"`)
				socket.disconnect(true)
				return
			}

			const child = this.children.get(connectionId)
			if (!child) {
				this.logger.debug(`Got register for bad connectionId: "${connectionId}"`)
				socket.disconnect(true)
				return
			}

			if (child.socket) {
				this.logger.debug(`Got register for already registered connectionId: "${connectionId}"`)
				socket.disconnect(true)
				return
			}

			if (child.authToken !== token) {
				this.logger.debug(`Got register with bad auth token for connectionId: "${connectionId}"`)
				socket.disconnect(true)
				return
			}

			socket.on('disconnect', () => {
				const child2 = this.children.get(connectionId)
				if (child2 && child2.socket === socket) {
					// If this socket is the one for a connection, then cleanup on close
					delete child2.socket
				}
			})

			// Bind the event listeners
			child.handler = new SocketEventsHandler(this.registry, this.instanceStatus, socket, connectionId)

			// Register successful
			child.socket = socket
			// child.doWorkTask = registerResult.doWorkTask
			this.logger.debug(`Registered module client "${connectionId}"`)

			// TODO module-lib - can we get this in a cleaner way?
			const config = this.registry.instance.store.db[connectionId]
			if (!config) {
				this.logger.verbose(`Missing config for instance "${connectionId}"`)
				socket.disconnect(true)
				return
			}
			const moduleInfo = this.registry.instance.known_modules[config.instance_type]
			if (!config) {
				this.logger.verbose(`Missing manifest for instance "${connectionId}"`)
				socket.disconnect(true)
				return
			}

			// report success
			cb()

			// TODO module-lib - start pings

			// Init module
			child.handler.init(config).catch((e) => {
				this.logger.warn(`Instance "${child.connectionId}" failed to init:`, e, e?.stack)

				// Force restart the connetion, as it failed to initialise and will be broken
				this.queueRestartConnection(connectionId, config, moduleInfo)
			})
		})
	}

	/**
	 * Get a handle to an active instance
	 * @param {string} connectionId
	 * @returns {any} ??
	 */
	getChild(connectionId) {
		const child = this.children.get(connectionId)
		if (child) {
			return child.handler
		} else {
			return undefined
		}
	}

	/**
	 * Resend feedbacks to all active instances.
	 * This will trigger a subscribe call for each feedback
	 */
	resubscribeAllFeedbacks() {
		for (const child of this.children.values()) {
			if (child.handler) {
				child.handler.sendAllFeedbackInstances().catch((e) => {
					this.logger.warn(`sendAllFeedbackInstances failed for "${child.connectionId}": ${e}`)
				})
			}
		}
	}

	/**
	 * Stop all running instances
	 */
	async queueStopAllConnections() {
		const ps = []

		for (const connectionId of this.children.keys()) {
			ps.push(this.queueStopConnection(connectionId))
		}

		await Promise.all(ps)
	}

	/**
	 * Stop an instance process/thread
	 * @param {string} connectionId
	 */
	async queueStopConnection(connectionId) {
		const child = this.children.get(connectionId)
		if (child) {
			await child.lifeCycleQueue.add(async () => this.#doStopConnectionInner(connectionId, true))
		}
	}

	/**
	 * Stop an instance running
	 * @access private
	 * @param {string} connectionId
	 * @param {boolean} allowDeleteIfEmpty delete the work-queue if it has no further jobs
	 */
	async #doStopConnectionInner(connectionId, allowDeleteIfEmpty) {
		const child = this.children.get(connectionId)
		if (child) {
			// Ensure a new child cant register
			delete child.authToken

			if (child.handler) {
				// Perform cleanup of the module and event listeners
				try {
					await child.handler.destroy()
				} catch (e) {
					console.error(`Destroy failed: ${e}`)
				}
			}

			if (child.socket) {
				// Stop the child connection
				child.socket.disconnect(true)
				delete child.socket
			}

			if (child.monitor) {
				// Stop the child process
				const monitor = child.monitor
				await new Promise((resolve) => monitor.stop(resolve))
			}

			if (allowDeleteIfEmpty && child.lifeCycleQueue.size === 0) {
				// Delete the queue now that it is empty
				this.children.delete(connectionId)
			}
		}
	}

	/**
	 * Start or restart an instance process
	 * @access public
	 * @param {string} connectionId
	 * @param {object} config
	 * @param {object} moduleInfo
	 */
	async queueRestartConnection(connectionId, config, moduleInfo) {
		if (!config || !moduleInfo) return

		let child = this.children.get(connectionId)
		if (!child) {
			// Create a new child entry
			child = {
				connectionId,
				lifeCycleQueue: new PQueue({ concurrency: 1 }),
				logger: this.registry.log.createLogger(`Instance/${config.label}`), // TODO - needs to update when label changes
			}
			this.children.set(connectionId, child)
		}

		await child.lifeCycleQueue.add(async () => {
			if (config && config.enabled !== false) {
				this.logger.info(`Starting connection: "${config.label}"(${connectionId})`)

				if (moduleInfo.manifest.runtime.api !== 'socket.io') {
					this.logger.error(`Only socket.io api is supported currently: "${connectionId}"`)
					return
				}

				const child = this.children.get(connectionId)
				if (!child) {
					this.logger.verbose(`Lost tracking object for connection: "${connectionId}"`)
					return
				}

				// stop any existing child process
				await this.#doStopConnectionInner(connectionId, false)

				child.authToken = shortid()
				const cmd = [
					// Future: vary depending on module version
					// 'node', // For now we can use fork
					path.join(moduleInfo.basePath, 'companion', moduleInfo.manifest.runtime.entrypoint),
				]
				this.logger.silly(`Connection "${config.label}" command: ${JSON.stringify(cmd)}`)

				const monitor = Respawn(cmd, {
					name: `Connection "${config.label}"(${connectionId})`,
					env: {
						CONNECTION_ID: connectionId,
						SOCKETIO_URL: `ws://localhost:${this.socketPort}`,
						SOCKETIO_TOKEN: child.authToken,
						MODULE_MANIFEST: path.join(moduleInfo.basePath, 'companion/manifest.json'),
					},
					maxRestarts: -1,
					kill: 5000,
					cwd: moduleInfo.basePath,
					fork: true, // Future: temporary until we want multiple node/runtime versions
					stdio: 'pipe',
				})

				// TODO module-lib - better event listeners
				monitor.on('start', () => {
					this.logger.debug(`Connection "${config.label}" started`)
				})
				monitor.on('stop', () => {
					this.updateStatus(null, 'Stopped')
					this.logger.debug(`Connection "${config.label}" stopped`)
				})
				monitor.on('crash', () => {
					this.updateStatus(null, 'Crashed')
					this.logger.debug(`Connection "${config.label}" crashed`)
				})
				monitor.on('stdout', (data) => {
					child.logger.verbose(`stdout: ${data.toString()}`)
				})
				monitor.on('stderr', (data) => {
					child.logger.verbose(`stderr: ${data.toString()}`)
				})

				child.monitor = monitor

				// Start the child
				child.monitor.start()

				// TODO module-lib - timeout for first contact
			} else {
				this.logger.debug(`Attempting to start missing connection: "${connectionId}"`)
				await this.#doStopConnectionInner(connectionId, true)
			}
		})
	}
}

export default ModuleHost