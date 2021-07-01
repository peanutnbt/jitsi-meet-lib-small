import JitsiTrack from './JitsiTrack';
/**
 * Represents a single media track (either audio or video).
 */
export default class JitsiRemoteTrack extends JitsiTrack {
    /**
     * Creates new JitsiRemoteTrack instance.
     * @param {RTC} rtc the RTC service instance.
     * @param {JitsiConference} conference the conference to which this track
     *        belongs to
     * @param {string} ownerEndpointId the endpoint ID of the track owner
     * @param {MediaStream} stream WebRTC MediaStream, parent of the track
     * @param {MediaStreamTrack} track underlying WebRTC MediaStreamTrack for
     *        the new JitsiRemoteTrack
     * @param {number} ssrc the SSRC number of the Media Stream
     * @param {boolean} muted the initial muted state
     * @param {boolean} isP2P indicates whether or not this track belongs to a
     * P2P session
     * @throws {TypeError} if <tt>ssrc</tt> is not a number.
     * @constructor
     */
    constructor(
            rtc,
            conference,
            ownerEndpointId,
            stream,
            track,
            mediaType,
            videoType,
            ssrc,
            muted,
            isP2P) {
        super(conference,stream,track,() => {},mediaType,videoType);
        this.rtc = rtc;
        // Prevent from mixing up type of SSRC which should be a number
        if (typeof ssrc !== 'number') {
            throw new TypeError(`SSRC ${ssrc} is not a number`);
        }
        this.ssrc = ssrc;
        this.ownerEndpointId = ownerEndpointId;
        this.muted = muted;
        this.isP2P = isP2P;

        // we want to mark whether the track has been ever muted
        // to detect ttfm events for startmuted conferences, as it can
        // significantly increase ttfm values
        this.hasBeenMuted = muted;
    }

    /**
     * Returns the current muted status of the track.
     * @returns {boolean|*|JitsiRemoteTrack.muted} <tt>true</tt> if the track is
     * muted and <tt>false</tt> otherwise.
     */
    isMuted() {
        return this.muted;
    }

    /**
     * Returns the participant id which owns the track.
     *
     * @returns {string} the id of the participants. It corresponds to the
     * Colibri endpoint id/MUC nickname in case of Jitsi-meet.
     */
    getParticipantId() {
        return this.ownerEndpointId;
    }

    /**
     * Return false;
     */
    isLocal() {
        return false;
    }

    /**
     * Returns the synchronization source identifier (SSRC) of this remote
     * track.
     *
     * @returns {number} the SSRC of this remote track.
     */
    getSSRC() {
        return this.ssrc;
    }
}
