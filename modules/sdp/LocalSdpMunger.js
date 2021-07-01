/* global __filename */

import { SdpTransformWrap } from './SdpTransformUtil';

/**
 * Fakes local SDP exposed to {@link JingleSessionPC} through the local
 * description getter. Modifies the SDP, so that it will contain muted local
 * video tracks description, even though their underlying {MediaStreamTrack}s
 * are no longer in the WebRTC peerconnection. That prevents from SSRC updates
 * being sent to Jicofo/remote peer and prevents sRD/sLD cycle on the remote
 * side.
 */
export default class LocalSdpMunger {

    /**
     * Creates new <tt>LocalSdpMunger</tt> instance.
     *
     * @param {TraceablePeerConnection} tpc
     * @param {string} localEndpointId - The endpoint id of the local user.
     */
    constructor(tpc, localEndpointId) {
        this.tpc = tpc;
        this.localEndpointId = localEndpointId;
    }
    /**
     * Returns a string that can be set as the MSID attribute for a source.
     *
     * @param {string} mediaType - Media type of the source.
     * @param {string} trackId - Id of the MediaStreamTrack associated with the source.
     * @param {string} streamId - Id of the MediaStream associated with the source.
     * @returns {string|null}
     */
    _generateMsidAttribute(mediaType, trackId, streamId = null) {
        if (!(mediaType && trackId)) {
            return null;
        }
        const pcId = this.tpc.id;

        // Handle a case on Firefox when the browser doesn't produce a 'a:ssrc' line with the 'msid' attribute or has
        // '-' for the stream id part of the msid line. Jicofo needs an unique identifier to be associated with a ssrc
        // and uses the msid for that.
        if (streamId === '-' || !streamId) {
            return `${this.localEndpointId}-${mediaType}-${pcId} ${trackId}-${pcId}`;
        }

        return `${streamId}-${pcId} ${trackId}-${pcId}`;
    }

    /**
     * Modifies 'cname', 'msid', 'label' and 'mslabel' by appending
     * the id of {@link LocalSdpMunger#tpc} at the end, preceding by a dash
     * sign.
     *
     * @param {MLineWrap} mediaSection - The media part (audio or video) of the
     * session description which will be modified in place.
     * @returns {void}
     * @private
     */
    _transformMediaIdentifiers(mediaSection) {
        const pcId = this.tpc.id;

        for (const ssrcLine of mediaSection.ssrcs) {
            switch (ssrcLine.attribute) {
            case 'cname':
            case 'label':
            case 'mslabel':
                ssrcLine.value = ssrcLine.value && `${ssrcLine.value}-${pcId}`;
                break;
            case 'msid': {
                if (ssrcLine.value) {
                    const streamAndTrackIDs = ssrcLine.value.split(' ');

                    if (streamAndTrackIDs.length === 2) {
                        ssrcLine.value
                            = this._generateMsidAttribute(
                                mediaSection.mLine?.type,
                                streamAndTrackIDs[1],
                                streamAndTrackIDs[0]);
                    }
                }
                break;
            }
            }
        }

        // If the msid attribute is missing, then remove the ssrc from the transformed description so that a
        // source-remove is signaled to Jicofo. This happens when the direction of the transceiver (or m-line)
        // is set to 'inactive' or 'recvonly' on Firefox, Chrome (unified) and Safari.
        const msid = mediaSection.ssrcs.find(s => s.attribute === 'msid');

        if (!this.tpc.isP2P
            && (!msid
                || mediaSection.mLine?.direction === 'recvonly'
                || mediaSection.mLine?.direction === 'inactive')) {
            mediaSection.ssrcs = undefined;
            mediaSection.ssrcGroups = undefined;

        // Add the msid attribute if it is missing for p2p sources. Firefox doesn't produce a a=ssrc line
        // with msid attribute.
        } else if (this.tpc.isP2P && mediaSection.mLine?.direction === 'sendrecv') {
            const msidLine = mediaSection.mLine?.msid;
            const trackId = msidLine && msidLine.split(' ')[1];
            const sources = [ ...new Set(mediaSection.mLine?.ssrcs?.map(s => s.id)) ];

            for (const source of sources) {
                const msidExists = mediaSection.ssrcs
                    .find(ssrc => ssrc.id === source && ssrc.attribute === 'msid');

                if (!msidExists) {
                    const generatedMsid = this._generateMsidAttribute(mediaSection.mLine?.type, trackId);

                    mediaSection.ssrcs.push({
                        id: source,
                        attribute: 'msid',
                        value: generatedMsid
                    });
                }
            }
        }
    }

    /**
     * This transformation will make sure that stream identifiers are unique
     * across all of the local PeerConnections even if the same stream is used
     * by multiple instances at the same time.
     * Each PeerConnection assigns different SSRCs to the same local
     * MediaStream, but the MSID remains the same as it's used to identify
     * the stream by the WebRTC backend. The transformation will append
     * {@link TraceablePeerConnection#id} at the end of each stream's identifier
     * ("cname", "msid", "label" and "mslabel").
     *
     * @param {RTCSessionDescription} sessionDesc - The local session
     * description (this instance remains unchanged).
     * @return {RTCSessionDescription} - Transformed local session description
     * (a modified copy of the one given as the input).
     */
    transformStreamIdentifiers(sessionDesc) {
        // FIXME similar check is probably duplicated in all other transformers
        if (!sessionDesc || !sessionDesc.sdp || !sessionDesc.type) {
            return sessionDesc;
        }

        const transformer = new SdpTransformWrap(sessionDesc.sdp);
        const audioMLine = transformer.selectMedia('audio');

        if (audioMLine) {
            this._transformMediaIdentifiers(audioMLine);
        }

        const videoMLine = transformer.selectMedia('video');

        if (videoMLine) {
            this._transformMediaIdentifiers(videoMLine);
        }

        return new RTCSessionDescription({
            type: sessionDesc.type,
            sdp: transformer.toRawSDP()
        });
    }
}
