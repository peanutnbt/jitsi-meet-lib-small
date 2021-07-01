import { $iq } from 'strophe.js';

import Settings from '../settings/Settings';


/**
 *
 * @param roomName
 * @param xmpp
 * @param emitter
 * @param options
 */
export default function Moderator(roomName, xmpp, emitter, options) {
    console.log("----------New Moderator----------")

    this.roomName = roomName;
    this.xmppService = xmpp;

    this.options = options;
    this.eventEmitter = emitter;

    this.connection = this.xmppService.connection;
}

Moderator.prototype.setFocusUserJid = function(focusJid) {
    if (!this.focusUserJid) {
        this.focusUserJid = focusJid;
    }
};

Moderator.prototype.getFocusUserJid = function() {
    return this.focusUserJid;
};

Moderator.prototype.getFocusComponent = function() {
    // Get focus component address
    let focusComponent = this.options.connection.hosts.focus;

    // If not specified use default:  'focus.domain'

    if (!focusComponent) {
        focusComponent = `focus.${this.options.connection.hosts.domain}`;
    }

    return focusComponent;
};

Moderator.prototype.createConferenceIq = function() {
    // Generate create conference IQ
    const elem = $iq({ to: this.getFocusComponent(),
        type: 'set' });

    // Session Id used for authentication
    const { sessionId } = Settings;
    const machineUID = Settings.machineId;
    const config = this.options.conference;

    elem.c('conference', {
        xmlns: 'http://jitsi.org/protocol/focus',
        room: this.roomName,
        'machine-uid': machineUID
    });

    if (sessionId) {
        elem.attrs({ 'session-id': sessionId });
    }

    elem.c(
        'property', {
            name: 'disableRtx',
            value: Boolean(config.disableRtx)
        }).up();

    elem.up();

    return elem;
};


Moderator.prototype.parseSessionId = function(resultIq) {
    // eslint-disable-next-line newline-per-chained-call
    const sessionId = $(resultIq).find('conference').attr('session-id');

    if (sessionId) {
        Settings.sessionId = sessionId;
    }
};

Moderator.prototype.parseConfigOptions = function(resultIq) {
    // eslint-disable-next-line newline-per-chained-call
    this.setFocusUserJid($(resultIq).find('conference').attr('focusjid'));

    const authenticationEnabled
        = $(resultIq).find(
            '>conference>property'
            + '[name=\'authentication\'][value=\'true\']').length > 0;

    this.externalAuthEnabled = $(resultIq).find(
        '>conference>property'
            + '[name=\'externalAuth\'][value=\'true\']').length > 0;

    if (!this.externalAuthEnabled) {
        // We expect to receive sessionId in 'internal' authentication mode
        this.parseSessionId(resultIq);
    }

    // Check if jicofo has jigasi support enabled.
    if ($(resultIq).find(
        '>conference>property'
        + '[name=\'sipGatewayEnabled\'][value=\'true\']').length) {
        this.sipGatewayEnabled = true;
    }
};

// FIXME We need to show the fact that we're waiting for the focus to the user
// (or that the focus is not available)
/**
 * Allocates the conference focus.
 *
 * @param {Function} callback - the function to be called back upon the
 * successful allocation of the conference focus
 * @returns {Promise} - Resolved when Jicofo allows to join the room. It's never
 * rejected and it'll keep on pinging Jicofo forever.
 */
Moderator.prototype.allocateConferenceFocus = function() {
    return new Promise(resolve => {
        // Send create conference IQ
        console.log("----------Send create conference IQ---------")
        this.connection.sendIQ(
            this.createConferenceIq(),
            result => this._allocateConferenceFocusSuccess(result, resolve));

        // XXX We're pressed for time here because we're beginning a complex
        // and/or lengthy conference-establishment process which supposedly
        // involves multiple RTTs. We don't have the time to wait for Strophe to
        // decide to send our IQ.
        // this.connection.flush();
    });
};

/**
 * Invoked by {@link #allocateConferenceFocus} upon its request receiving a
 * success (i.e. non-error) result.
 *
 * @param result - the success (i.e. non-error) result of the request that
 * {@link #allocateConferenceFocus} sent
 * @param {Function} callback - the function to be called back upon the
 * successful allocation of the conference focus
 */
Moderator.prototype._allocateConferenceFocusSuccess = function(
        result,
        callback) {
    // Setup config options
    this.parseConfigOptions(result);

    // Reset the error timeout (because we haven't failed here).

    // eslint-disable-next-line newline-per-chained-call
    if ($(result).find('conference').attr('ready') === 'true') {
        // Reset the non-error timeout (because we've succeeded here).
        // Exec callback
        console.log("----------Send Conference IQ success----------")
        callback();
    } 
};