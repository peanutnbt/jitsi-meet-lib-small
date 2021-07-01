import { $iq, Strophe } from 'strophe.js';

import ConnectionPlugin from './ConnectionPlugin';
import JingleSessionPC from './JingleSessionPC';
export default class JingleConnectionPlugin extends ConnectionPlugin {
    constructor(xmpp, eventEmitter, iceConfig) {
        console.log("----------New Jingle Plugin----------")
        super();
        this.xmpp = xmpp;
        this.eventEmitter = eventEmitter;
        this.sessions = {};
        this.jvbIceConfig = iceConfig.jvb;
        this.p2pIceConfig = iceConfig.p2p;
        this.mediaConstraints = {
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        };
    }

    init(connection) {
        super.init(connection);
        this.connection.addHandler(this.onJingle.bind(this),
            'urn:xmpp:jingle:1', 'iq', 'set', null, null);
    }

    onJingle(iq) {
        console.log("-----------------------------")
        console.log("----------On Jingle----------")
        const sid = $(iq).find('jingle').attr('sid');
        const action = $(iq).find('jingle').attr('action');
        const fromJid = iq.getAttribute('from');

        // send ack first
        const ack = $iq({
            type: 'result',
            to: fromJid,
            id: iq.getAttribute('id')
        });

        let sess = this.sessions[sid];

        const now = window.performance.now();

        // FIXME that should work most of the time, but we'd have to
        // think how secure it is to assume that user with "focus"
        // nickname is Jicofo.
        const isP2P = Strophe.getResourceFromJid(fromJid) !== 'focus';

        // see http://xmpp.org/extensions/xep-0166.html#concepts-session

        switch (action) {
            case 'session-initiate': {
                console.log("----------session-initiate----------")
                const iceConfig = isP2P ? this.p2pIceConfig : this.jvbIceConfig;

                sess = new JingleSessionPC(
                        $(iq).find('jingle').attr('sid'),
                        $(iq).attr('to'),
                        fromJid,
                        this.connection,
                        this.mediaConstraints,
                        // Makes a copy in order to prevent exception thrown on RN when either this.p2pIceConfig or
                        // this.jvbIceConfig is modified and there's a PeerConnection instance holding a reference
                        JSON.parse(JSON.stringify(iceConfig)),
                        isP2P,
                    /* initiator */ false);

                // this.sessions[sess.sid] = sess;

                this.eventEmitter.emit('xmpp.callincoming.jingle', sess, $(iq).find('>jingle'), now);
                break;
            }
        }
        this.connection.send(ack);

        return true;
    }

}

/* eslint-enable newline-per-chained-call */
