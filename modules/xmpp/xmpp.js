import { Strophe } from 'strophe.js';
import 'strophejs-plugin-disco';

import Listenable from '../util/Listenable';
import RandomUtil from '../util/RandomUtil';

import Caps from './Caps';
import XmppConnection from './XmppConnection';
import MucConnectionPlugin from './strophe.emuc';
import JingleConnectionPlugin from './strophe.jingle';
import initStropheUtil from './strophe.util';

function createConnection({serviceUrl = '/http-bind'}) {
    return new XmppConnection({serviceUrl});
}

/**
 * Initializes Strophe plugins that need to work with Strophe.Connection directly rather than the lib-jitsi-meet's
 * {@link XmppConnection} wrapper.
 *
 * @returns {void}
 */
function initStropheNativePlugins() {
    initStropheUtil();
}

export const DEFAULT_STUN_SERVERS = [
    { urls: 'stun:meet-jit-si-turnrelay.jitsi.net:443' }
];

/**
 * The name of the field used to recognize a chat message as carrying a JSON
 * payload from another endpoint.
 * If the json-message of a chat message contains a valid JSON object, and
 * the JSON has this key, then it is a valid json-message to be sent.
 */
export const JITSI_MEET_MUC_TYPE = 'type';

export default class XMPP extends Listenable {
    /**
     * FIXME describe all options
     * @param {Object} options
     * @param {String} options.serviceUrl - URL passed to the XMPP client which will be used to establish XMPP
     * connection with the server.
     * @param {String} options.bosh - Deprecated, use {@code serviceUrl}.
     */
    constructor(options) {
        super();
        this.connection = null;
        this.options = options;
        this.authenticatedUser = false;

        initStropheNativePlugins();

        this.connection = createConnection({
            serviceUrl: options.serviceUrl || options.bosh,
        });

        this._initStrophePlugins();

        this.caps = new Caps(this.connection);

        // Initialize features advertised in disco-info
        this.initFeaturesList();
    }

    /**
     * Initializes the list of feature advertised through the disco-info
     * mechanism.
     */
    initFeaturesList() {
        // http://xmpp.org/extensions/xep-0167.html#support
        // http://xmpp.org/extensions/xep-0176.html#support
        this.caps.addFeature('urn:xmpp:jingle:1');
        this.caps.addFeature('urn:xmpp:jingle:apps:rtp:1');
        this.caps.addFeature('urn:xmpp:jingle:transports:ice-udp:1');
        this.caps.addFeature('urn:xmpp:jingle:apps:dtls:0');
        this.caps.addFeature('urn:xmpp:jingle:transports:dtls-sctp:1');
        this.caps.addFeature('urn:xmpp:jingle:apps:rtp:audio');
        this.caps.addFeature('urn:xmpp:jingle:apps:rtp:video');
        // this is dealt with by SDP O/A so we don't need to announce this
        // XEP-0293
        // this.caps.addFeature('urn:xmpp:jingle:apps:rtp:rtcp-fb:0');
        // XEP-0294
        // this.caps.addFeature('urn:xmpp:jingle:apps:rtp:rtp-hdrext:0');

        this.caps.addFeature('urn:ietf:rfc:5761'); // rtcp-mux
        this.caps.addFeature('urn:ietf:rfc:5888'); // a=group, e.g. bundle

    }

    /**
     * Receive connection status changes and handles them.
     *
     * @param {Object} credentials
     * @param {string} credentials.jid - The user's XMPP ID passed to the
     * connect method. For example, 'user@xmpp.com'.
     * @param {string} credentials.password - The password passed to the connect
     * method.
     * @param {string} status - One of Strophe's connection status strings.
     * @param {string} [msg] - The connection error message provided by Strophe.
     */
    connectionHandler(credentials = {}, status, msg) {
        console.log("----------Call back xmpp connection---------:", Strophe.Status.CONNECTED, status)
        if (status === Strophe.Status.CONNECTED || status === Strophe.Status.ATTACHED) {
            // XmppConnection emits CONNECTED again on reconnect - a good opportunity to clear any "last error" flags
            // make sure we don't query again
            this.sendDiscoInfo = false;

            if (this.connection && this.connection.connected
                && Strophe.getResourceFromJid(this.connection.jid)) {
                // .connected is true while connecting?
                // this.connection.send($pres());
                console.log("----------JID RESOURCE---------:", this.connection.jid)
                this.eventEmitter.emit('connection.connectionEstablished',Strophe.getResourceFromJid(this.connection.jid));
            }
        } 
    }

    /**
     *
     * @param jid
     * @param password
     */
    _connect(jid, password) {
        // connection.connect() starts the connection process.
        //
        // As the connection process proceeds, the user supplied callback will
        // be triggered multiple times with status updates. The callback should
        // take two arguments - the status code and the error condition.
        //
        // The status code will be one of the values in the Strophe.Status
        // constants. The error condition will be one of the conditions defined
        // in RFC 3920 or the condition ‘strophe-parsererror’.
        //
        // The Parameters wait, hold and route are optional and only relevant
        // for BOSH connections. Please see XEP 124 for a more detailed
        // explanation of the optional parameters.
        //
        // Connection status constants for use by the connection handler
        // callback.
        //
        //  Status.ERROR - An error has occurred (websockets specific)
        //  Status.CONNECTING - The connection is currently being made
        //  Status.CONNFAIL - The connection attempt failed
        //  Status.AUTHENTICATING - The connection is authenticating
        //  Status.AUTHFAIL - The authentication attempt failed
        //  Status.CONNECTED - The connection has succeeded
        //  Status.DISCONNECTED - The connection has been terminated
        //  Status.DISCONNECTING - The connection is currently being terminated
        //  Status.ATTACHED - The connection has been attached

        // we want to send this only on the initial connect
        this.sendDiscoInfo = true;

        this.connection.connect(
            jid,
            password,
            this.connectionHandler.bind(this, {
                jid,
                password
            }));
    }


    /**
     *
     * @param jid
     * @param password
     */
    connect(jid, password) {
        if (!jid) {
            jid = this.options.hosts.domain;
        }
        return this._connect(jid, password);
    }

    /**
     * Joins or creates a muc with the provided jid, created from the passed
     * in room name and muc host and onCreateResource result.
     *
     * @param {string} roomName - The name of the muc to join.
     * @param {Object} options - Configuration for how to join the muc.
     * @returns {Promise} Resolves with an instance of a strophe muc.
     */
    createRoom(roomName, options) {
        // There are cases (when using subdomain) where muc can hold an uppercase part
        let roomjid = `${roomName}@${options.customDomain
            ? options.customDomain : this.options.hosts.muc.toLowerCase()}/`;
        
        
        const mucNickname = RandomUtil.randomHexString(8).toLowerCase();
        
        roomjid += mucNickname;
        console.log("----------Create Room roomjid-----------:", roomjid)
        return this.connection.emuc.createRoom(roomjid, null, options);
    }

    _initStrophePlugins() {
        const iceConfig = {
            jvb: { iceServers: [ ] },
            p2p: { iceServers: [ ] }
        };

        this.connection.addConnectionPlugin('emuc', new MucConnectionPlugin(this));
        this.connection.addConnectionPlugin('jingle', new JingleConnectionPlugin(this, this.eventEmitter, iceConfig));
    }
}
