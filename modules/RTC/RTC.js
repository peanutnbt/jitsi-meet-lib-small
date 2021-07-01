import Listenable from '../util/Listenable';
import TraceablePeerConnection from './TraceablePeerConnection';

let peerConnectionIdCounter = 0;
export default class RTC extends Listenable {

    constructor(conference, options = {}) {
        super();
        this.conference = conference;

        this.peerConnections = new Map();

        this.localTracks = [];
    }

    static init(options = {}) {
        this.attachMediaStream = (element, stream) => {
            if (element) {
                element.srcObject = stream;

            }
        }
    }

    safeCounterIncrement(number) {
        let nextValue = number;
    
        if (number >= Number.MAX_SAFE_INTEGER) {
            nextValue = 0;
        }
    
        return nextValue + 1;
    }
    /**
     * Creates new <tt>TraceablePeerConnection</tt>
     * @param {SignalingLayer} signaling The signaling layer that will
     *      provide information about the media or participants which is not
     *      carried over SDP.
     * @param {object} iceConfig An object describing the ICE config like
     *      defined in the WebRTC specification.
     * @param {boolean} isP2P Indicates whether or not the new TPC will be used
     *      in a peer to peer type of session.
     */
    createPeerConnection(signaling, iceConfig, isP2P, options) {
        console.log("----------RTC CreatePeerConnection----------")
        const pcConstraints = {};
        // Set the RTCBundlePolicy to max-bundle so that only one set of ice candidates is generated.
        // The default policy generates separate ice candidates for audio and video connections.
        // This change is necessary for Unified plan to work properly on Chrome and Safari.
        iceConfig.bundlePolicy = 'max-bundle';

        peerConnectionIdCounter = this.safeCounterIncrement(peerConnectionIdCounter);

        const newConnection = new TraceablePeerConnection(this, peerConnectionIdCounter, signaling, iceConfig, pcConstraints, isP2P, options);

        this.peerConnections.set(newConnection.id, newConnection);

        return newConnection;
    }

    
    /**
     * Returns the endpoint id for the local user.
     * @returns {string}
     */
    getLocalEndpointId() {
        return this.conference.myUserId();
    }

    /**
     * Returns the local tracks of the given media type, or all local tracks if
     * no specific type is given.
     * (audio or video).
     */
    getLocalTracks(mediaType) {
        let tracks = this.localTracks.slice();

        if (mediaType !== undefined) {
            tracks = tracks.filter(
                track => track.getType() === mediaType);
        }

        return tracks;
    }

    /**
     * Returns <tt>true<tt/> if a WebRTC MediaStream identified by given stream
     * ID is considered a valid "user" stream which means that it's not a
     * "receive only" stream nor a "mixed" JVB stream.
     *
     * Clients that implement Unified Plan, such as Firefox use recvonly
     * "streams/channels/tracks" for receiving remote stream/tracks, as opposed
     * to Plan B where there are only 3 channels: audio, video and data.
     *
     * @param {string} streamId The id of WebRTC MediaStream.
     * @returns {boolean}
     */
    static isUserStreamById(streamId) {
        return streamId && streamId !== 'mixedmslabel'
            && streamId !== 'default';
    }

}
