import JitsiConference from './JitsiConference';
import XMPP from './modules/xmpp/xmpp';

/**
 * Creates a new connection object for the Jitsi Meet server side video
 * conferencing service. Provides access to the JitsiConference interface.
 * @param appID identification for the provider of Jitsi Meet video conferencing
 * services.
 * @param token the JWT token used to authenticate with the server(optional)
 * @param options Object with properties / settings related to connection with
 * the server.
 * @constructor
 */
export default function JitsiConnection(options) {
    this.options = options;
    this.xmpp = new XMPP(options);
}

/**
 * Connect the client with the server.
 * @param options {object} connecting options
 * (for example authentications parameters).
 */
JitsiConnection.prototype.connect = function(options = {}) {
    this.xmpp.connect(options.id, options.password);
};

/**
 * Creates and joins new conference.
 * @param name the name of the conference; if null - a generated name will be
 * provided from the api
 * @param options Object with properties / settings related to the conference
 * that will be created.
 * @returns {JitsiConference} returns the new conference object.
 */
JitsiConnection.prototype.initJitsiConference = function(name, options) {
    console.log("----------Init JitsiConference----------: ", name)
    return new JitsiConference({
        name,
        config: options,
        connection: this
    });
};

JitsiConnection.prototype.addEventListener = function(event, listener) {
    this.xmpp.addListener(event, listener);
};

