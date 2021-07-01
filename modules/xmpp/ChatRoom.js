import { $msg, $pres, Strophe } from 'strophe.js';

import Listenable from '../util/Listenable';

import XmppConnection from './XmppConnection';
import Moderator from './moderator';

export const parser = {
    packet2JSON(xmlElement, nodes) {
        for (const child of Array.from(xmlElement.children)) {
            const node = {
                attributes: {},
                children: [],
                tagName: child.tagName
            };

            for (const attr of Array.from(child.attributes)) {
                node.attributes[attr.name] = attr.value;
            }
            const text = Strophe.getText(child);

            if (text) {
                // Using Strophe.getText will do work for traversing all direct
                // child text nodes but returns an escaped value, which is not
                // desirable at this point.
                node.value = Strophe.xmlunescape(text);
            }
            nodes.push(node);
            this.packet2JSON(child, node.children);
        }
    },
    json2packet(nodes, packet) {
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];

            if (node) {
                packet.c(node.tagName, node.attributes);
                if (node.value) {
                    packet.t(node.value);
                }
                if (node.children) {
                    this.json2packet(node.children, packet);
                }
                packet.up();
            }
        }
    }
};

/**
 * Returns array of JS objects from the presence JSON associated with the passed
 / nodeName
 * @param pres the presence JSON
 * @param nodeName the name of the node (videomuted, audiomuted, etc)
 */
function filterNodeFromPresenceJSON(pres, nodeName) {
    const res = [];

    for (let i = 0; i < pres.length; i++) {
        if (pres[i].tagName === nodeName) {
            res.push(pres[i]);
        }
    }

    return res;
}

// XXX As ChatRoom constructs XMPP stanzas and Strophe is build around the idea
// of chaining function calls, allow long function call chains.
/* eslint-disable newline-per-chained-call */

/**
 * Array of affiliations that are allowed in members only room.
 * @type {string[]}
 */
export default class ChatRoom extends Listenable {
    /**
     *
     * @param {XmppConnection} connection - The XMPP connection instance.
     * @param jid
     * @param password
     * @param XMPP
     * @param options
     * @param {boolean} options.disableFocus - when set to {@code false} will
     * not invite Jicofo into the room.
     * @param {boolean} options.disableDiscoInfo - when set to {@code false} will skip disco info.
     */
    constructor(connection, jid, password, XMPP, options) {
        console.log("----------New Chat Room----------")
        super();
        this.xmpp = XMPP;
        this.connection = connection;
        this.roomjid = Strophe.getBareJidFromJid(jid);
        this.myroomjid = jid;
        this.password = password;
        this.replaceParticipant = false;
        this.members = {};
        this.presMap = {};
        this.presHandlers = {};
        this.joined = false;
        this.role = null;
        this.focusMucJid = null;
        this.options = options || {};
        this.moderator
            = new Moderator(this.roomjid, this.xmpp, this.eventEmitter, {
                connection: this.xmpp.options,
                conference: this.options
            });
        this.initPresenceMap(options);
        this.lastPresences = {};
        this.participantPropertyListener = null;

    }

    /* eslint-enable max-params */

    /**
     *
     */
    initPresenceMap(options = {}) {
        this.presMap.to = this.myroomjid;
        this.presMap.xns = 'http://jabber.org/protocol/muc';
        this.presMap.nodes = [];
        console.log("----------Init PresenceMap----------: ", this.presMap)
        this.presenceUpdateTime = Date.now();
    }

    /**
     * Joins the chat room.
     * @param {string} password - Password to unlock room on joining.
     * @returns {Promise} - resolved when join completes. At the time of this
     * writing it's never rejected.
     */
    join(password, replaceParticipant) {
        console.log("----------Join Chat Room---------: ", this.options.disableFocus)
        this.password = password;
        this.replaceParticipant = replaceParticipant;

        return new Promise(resolve => {
            const preJoin = this.moderator.allocateConferenceFocus();

            preJoin.then(() => {
                console.log("----------After send Iq create conference---------")
                this.sendPresence(true);
                resolve();
            });
        });
    }

    /**
     *
     * @param fromJoin - Whether this is initial presence to join the room.
     */
    sendPresence(fromJoin) {
        console.log("----------SendPresencee---------: ", fromJoin)
        const to = this.presMap.to;

        if (!this.connection || !this.connection.connected || !to || (!this.joined && !fromJoin)) {
            // Too early to send presence - not initialized
            return;
        }

        const pres = $pres({ to });

        // xep-0045 defines: "including in the initial presence stanza an empty
        // <x/> element qualified by the 'http://jabber.org/protocol/muc'
        // namespace" and subsequent presences should not include that or it can
        // be considered as joining, and server can send us the message history
        // for the room on every presence
        if (fromJoin) {
            // if (this.replaceParticipant) {
            //     pres.c('flip_device').up();
            // }

            pres.c('x', { xmlns: this.presMap.xns });

            // if (this.password) {
            //     pres.c('password').t(this.password).up();
            // }
            // if (this.options.billingId) {
            //     pres.c('billingid').t(this.options.billingId).up();
            // }

            pres.up();
        }

        parser.json2packet(this.presMap.nodes, pres);

        // we store time we last synced presence state
        // this.presenceSyncTime = Date.now();
        console.log("----------Chat Room -> Send stanza----------")
        this.connection.send(pres);
        // if (fromJoin) {
        //     // XXX We're pressed for time here because we're beginning a complex
        //     // and/or lengthy conference-establishment process which supposedly
        //     // involves multiple RTTs. We don't have the time to wait for
        //     // Strophe to decide to send our IQ.
        //     this.connection.flush();
        // }
    }

    /**
     *
     * @param pres
     */
    onPresence(pres) {
        const from = pres.getAttribute('from');
        const member = {};
        const statusEl = pres.getElementsByTagName('status')[0];

        if (statusEl) {
            member.status = statusEl.textContent || '';
        }
        const xElement
            = pres.getElementsByTagNameNS(
                'http://jabber.org/protocol/muc#user', 'x')[0];
        const mucUserItem
            = xElement && xElement.getElementsByTagName('item')[0];

        member.isReplaceParticipant
            = pres.getElementsByTagName('flip_device').length;

        member.affiliation
            = mucUserItem && mucUserItem.getAttribute('affiliation');
        member.role = mucUserItem && mucUserItem.getAttribute('role');

        // Focus recognition
        const jid = mucUserItem && mucUserItem.getAttribute('jid');

        member.jid = jid;
        member.isFocus
            = jid && jid.indexOf(`${this.moderator.getFocusUserJid()}/`) === 0;
        member.isHiddenDomain
            = jid && jid.indexOf('@') > 0
            && this.options.hiddenDomain
            === jid.substring(jid.indexOf('@') + 1, jid.indexOf('/'));

        this.eventEmitter.emit('xmpp.presence_received', {
            fromHiddenDomain: member.isHiddenDomain,
            presence: pres
        });

        const xEl = pres.querySelector('x');

        if (xEl) {
            xEl.remove();
        }

        const nodes = [];

        parser.packet2JSON(pres, nodes);
        this.lastPresences[from] = nodes;


        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];

            switch (node.tagName) {
                case 'userId':
                    member.id = node.value;
                    break;
            }
        }

        if (from === this.myroomjid) {
            if (!this.joined) {
                this.joined = true;
                // Re-send presence in case any presence updates were added,
                // but blocked from sending, during the join process.
                // send the presence only if there was a modification after we had synced it
                if (this.presenceUpdateTime >= this.presenceSyncTime) {
                    this.sendPresence();
                }

                this.eventEmitter.emit('xmpp.muc_joined');

            }
        } else if (this.members[from] === undefined) {
            // new participant
            this.members[from] = member;
            if (member.isFocus) {
                this._initFocus(from, member.features);
            } else {
                // identity is being added to member joined, so external
                // services can be notified for that (currently identity is
                // not used inside library)
                this.eventEmitter.emit(
                    'xmpp.muc_member_joined',
                    from,
                    member.nick,
                    member.role,
                    member.isHiddenDomain,
                    member.statsID,
                    member.status,
                    member.identity,
                    member.botType,
                    member.jid,
                    member.features,
                    member.isReplaceParticipant);
            }
        } 
    }
    /**
     * Initialize some properties when the focus participant is verified.
     * @param from jid of the focus
     * @param features the features reported in jicofo presence
     */
    _initFocus(from, features) {
        this.focusMucJid = from;
        this.focusFeatures = features;
    }

    /**
     * Send text message to the other participants in the conference
     * @param message
     * @param elementName
     */
    sendMessage(message, elementName) {
        const msg = $msg({
            to: this.roomjid,
            type: 'groupchat'
        });

        // We are adding the message in a packet extension. If this element
        // is different from 'body', we add a custom namespace.
        // e.g. for 'json-message' extension of message stanza.
        if (elementName === 'body') {
            msg.c(elementName, {}, message);
        } else {
            msg.c(elementName, { xmlns: 'http://jitsi.org/jitmeet' }, message);
        }

        this.connection.send(msg);
        this.eventEmitter.emit('xmpp.sending_chat_message', message);
    }
    /**
     *
     * @param name
     * @param handler
     */
    addPresenceListener(name, handler) {
        if (typeof handler !== 'function') {
            throw new Error('"handler" is not a function');
        }
        let tagHandlers = this.presHandlers[name];

        if (!tagHandlers) {
            this.presHandlers[name] = tagHandlers = [];
        }
        if (tagHandlers.indexOf(handler) === -1) {
            tagHandlers.push(handler);
        }
    }

    /**
     * Checks if the user identified by given <tt>mucJid</tt> is the conference
     * focus.
     * @param mucJid the full MUC address of the user to be checked.
     * @returns {boolean|null} <tt>true</tt> if MUC user is the conference focus
     * or <tt>false</tt> if is not. When given <tt>mucJid</tt> does not exist in
     * the MUC then <tt>null</tt> is returned.
     */
    isFocus(mucJid) {
        const member = this.members[mucJid];

        if (member) {
            return member.isFocus;
        }

        return null;
    }
    /**
     * Obtains the info about given media advertised in the MUC presence of
     * the participant identified by the given endpoint JID.
     * @param {string} endpointId the endpoint ID mapped to the participant
     * which corresponds to MUC nickname.
     * @return {PeerMediaInfo} presenceInfo an object with media presence
     * info or <tt>null</tt> either if there is no presence available or if
     * the media type given is invalid.
     */
    getMediaPresenceInfo(endpointId, mediaType) {
        // Will figure out current muted status by looking up owner's presence
        const pres = this.lastPresences[`${this.roomjid}/${endpointId}`];

        if (!pres) {
            // No presence available
            return null;
        }
        const data = {
            muted: true, // muted by default
            videoType: undefined // no video type by default
        };
        let mutedNode = null;

        if (mediaType === 'audio') {
            mutedNode = filterNodeFromPresenceJSON(pres, 'audiomuted');
        } else if (mediaType === 'video') {
            mutedNode = filterNodeFromPresenceJSON(pres, 'videomuted');
            const codecTypeNode = filterNodeFromPresenceJSON(pres, 'jitsi_participant_codecType');
            const videoTypeNode = filterNodeFromPresenceJSON(pres, 'videoType');

            if (videoTypeNode.length > 0) {
                data.videoType = videoTypeNode[0].value;
            }
            if (codecTypeNode.length > 0) {
                data.codecType = codecTypeNode[0].value;
            }
        } else {
            return null;
        }

        if (mutedNode.length > 0) {
            data.muted = mutedNode[0].value === 'true';
        }

        return data;
    }
}