import { Strophe } from 'strophe.js';
import 'strophejs-plugin-stream-management';

import Listenable from '../util/Listenable';
/**
 * The lib-jitsi-meet layer for {@link Strophe.Connection}.
 */
export default class XmppConnection extends Listenable {
    /**
     * The list of {@link XmppConnection} events.
     *
     * @returns {Object}
     */
    static get Events() {
        return {
            CONN_STATUS_CHANGED: 'CONN_STATUS_CHANGED',
            CONN_SHARD_CHANGED: 'CONN_SHARD_CHANGED'
        };
    }

    /**
     * The list of Xmpp connection statuses.
     *
     * @returns {Strophe.Status}
     */
    static get Status() {
        return Strophe.Status;
    }

    /**
     * Initializes new connection instance.
     *
     * @param {Object} options
     * @param {String} options.serviceUrl - The BOSH or WebSocket service URL.
     * @param {String} options.shard - The BOSH or WebSocket is connecting to this shard.
     * Useful for detecting when shard changes.
     * @param {String} [options.enableWebsocketResume=true] - True/false to control the stream resumption functionality.
     * It will enable automatically by default if supported by the XMPP server.
     * @param {Number} [options.websocketKeepAlive=60000] - The websocket keep alive interval.
     * It's the interval + a up to a minute of jitter. Pass -1 to disable.
     * The keep alive is HTTP GET request to {@link options.serviceUrl} or to {@link options.websocketKeepAliveUrl}.
     * @param {Number} [options.websocketKeepAliveUrl] - The websocket keep alive url to use if any,
     * if missing the serviceUrl url will be used.
     * @param {Object} [options.xmppPing] - The xmpp ping settings.
     */
    constructor({ serviceUrl }) {
        super();

        this._stropheConn = new Strophe.Connection(serviceUrl);
        console.log("----------Strophe Connection----------")
        this._usesWebsocket = serviceUrl.startsWith('ws:') || serviceUrl.startsWith('wss:');
        // The default maxRetries is 5, which is too long.
        this._stropheConn.maxRetries = 3;

        /**
         * @typedef DeferredSendIQ Object
         * @property {Element} iq - The IQ to send.
         * @property {function} resolve - The resolve method of the deferred Promise.
         * @property {function} reject - The reject method of the deferred Promise.
         * @property {number} timeout - The ID of the timeout task that needs to be cleared, before sending the IQ.
         */
        /**
         * Deferred IQs to be sent upon reconnect.
         * @type {Array<DeferredSendIQ>}
         * @private
         */
        this._deferredIQs = [];

        // tracks whether this is the initial connection or a reconnect
        this._oneSuccessfulConnect = false;
    }

    /**
     * A getter for the connected state.
     *
     * @returns {boolean}
     */
    get connected() {
        const websocket = this._stropheConn && this._stropheConn._proto && this._stropheConn._proto.socket;

        return (this._status === Strophe.Status.CONNECTED || this._status === Strophe.Status.ATTACHED)
            && (!this.isUsingWebSocket || (websocket && websocket.readyState === WebSocket.OPEN));
    }

    /**
     * Retrieves the feature discovery plugin instance.
     *
     * @returns {Strophe.Connection.disco}
     */
    get disco() {
        return this._stropheConn.disco;
    }

    /**
     * Tells if Websocket is used as the transport for the current XMPP connection. Returns true for Websocket or false
     * for BOSH.
     * @returns {boolean}
     */
    get isUsingWebSocket() {
        return this._usesWebsocket;
    }

    /**
     * A getter for the JID.
     *
     * @returns {string|null}
     */
    get jid() {
        return this._stropheConn.jid;
    }

    /**
     * Adds a connection plugin to this instance.
     *
     * @param {string} name - The name of the plugin or rather a key under which it will be stored on this connection
     * instance.
     * @param {ConnectionPluginListenable} plugin - The plugin to add.
     */
    addConnectionPlugin(name, plugin) {
        this[name] = plugin;
        plugin.init(this);
    }

    /**
     * See {@link Strophe.Connection.addHandler}
     *
     * @returns {void}
     */
    addHandler(...args) {
        console.log("----------Add Handler----------")
        this._stropheConn.addHandler(...args);
    }

    /**
     * Wraps Strophe.Connection.connect method in order to intercept the connection status updates.
     * See {@link Strophe.Connection.connect} for the params description.
     *
     * @returns {void}
     */
    connect(jid, pass, callback, ...args) {
        console.log("----------xmpp connect----------")
        this._stropheConn.connect(jid, pass, this._stropheConnectionCb.bind(this, callback), ...args);
    }

    /* eslint-enable max-params */

    /**
     * Handles {@link Strophe.Status} updates for the current connection.
     *
     * @param {function} targetCallback - The callback passed by the {@link XmppConnection} consumer to one of
     * the connect methods.
     * @param {Strophe.Status} status - The new connection status.
     * @param {*} args - The rest of the arguments passed by Strophe.
     * @private
     */
    _stropheConnectionCb(targetCallback, status, ...args) {
        this._status = status;
        targetCallback(status, ...args);
        this.eventEmitter.emit(XmppConnection.Events.CONN_STATUS_CHANGED, status);
    }
    /**
     * See {@link Strophe.Connection.flush}.
     *
     * @returns {void}
     */
    flush(...args) {
        this._stropheConn.flush(...args);
    }
    /**
     * Send a stanza. This function is called to push data onto the send queue to go out over the wire.
     *
     * @param {Element|Strophe.Builder} stanza - The stanza to send.
     * @returns {void}
     */
    send(stanza) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        console.log("----------Send stanza----------")
        this._stropheConn.send(stanza);
    }

    /**
     * Helper function to send IQ stanzas.
     *
     * @param {Element} elem - The stanza to send.
     * @param {Function} callback - The callback function for a successful request.
     * @param {Function} errback - The callback function for a failed or timed out request.  On timeout, the stanza will
     * be null.
     * @param {number} timeout - The time specified in milliseconds for a timeout to occur.
     * @returns {number} - The id used to send the IQ.
     */
    sendIQ(elem, callback, errback, timeout) {
        if (!this.connected) {
            errback('Not connected');
            return;
        }
        // console.log("----------elem---------:", elem)
        return this._stropheConn.sendIQ(elem, callback, errback, timeout);
    }

    /**
     * Sends an IQ immediately if connected or puts it on the send queue otherwise(in contrary to other send methods
     * which would fail immediately if disconnected).
     *
     * @param {Element} iq - The IQ to send.
     * @param {number} timeout - How long to wait for the response. The time when the connection is reconnecting is
     * included, which means that the IQ may never be sent and still fail with a timeout.
     */
    sendIQ2(iq, { timeout }) {
        return new Promise((resolve, reject) => {
            if (this.connected) {
                this.sendIQ(
                    iq,
                    result => resolve(result),
                    error => reject(error),
                    timeout);
            } else {
                const deferred = {
                    iq,
                    resolve,
                    reject,
                    start: Date.now(),
                    timeout: setTimeout(() => {
                        // clears the IQ on timeout and invalidates the deferred task
                        deferred.iq = undefined;

                        // Strophe calls with undefined on timeout
                        reject(undefined);
                    }, timeout)
                };

                this._deferredIQs.push(deferred);
            }
        });
    }

    /**
     *  Helper function to send presence stanzas. The main benefit is for sending presence stanzas for which you expect
     *  a responding presence stanza with the same id (for example when leaving a chat room).
     *
     * @param {Element} elem - The stanza to send.
     * @param {Function} callback - The callback function for a successful request.
     * @param {Function} errback - The callback function for a failed or timed out request. On timeout, the stanza will
     * be null.
     * @param {number} timeout - The time specified in milliseconds for a timeout to occur.
     * @returns {number} - The id used to send the presence.
     */
    sendPresence(elem, callback, errback, timeout) {
        if (!this.connected) {
            errback('Not connected');

            return;
        }
        this._stropheConn.sendPresence(elem, callback, errback, timeout);
    }
}
