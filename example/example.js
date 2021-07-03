const options = {
    hosts: {
        domain: 'jitsimeet.example.com',
        muc: 'conference.jitsimeet.example.com'
    },
    bosh: 'https://jitsimeet.example.com/http-bind',
};

let connection = null;
let isJoined = false;
let room = null;

const remoteTracks = {};

function onRemoteTrack(track) {
    console.log("---------On Remote Track---------")
    if (track.isLocal()) {
        return;
    }
    const participant = track.getParticipantId();

    if (!remoteTracks[participant]) {
        remoteTracks[participant] = [];
    }
    const idx = remoteTracks[participant].push(track);

    const id = participant + track.getType() + idx;

    if (track.getType() === 'video') {
        $('body').append(
            `<video autoplay='1' id='${participant}video${idx}' />`);
    } else {
        $('body').append(
            `<audio autoplay='1' id='${participant}audio${idx}' />`);
    }
    track.attach($(`#${id}`)[0]);
}

function onConnectionSuccess(e) {
    console.log("----------Listen CONNECTION_ESTABLISHED----------: ", e)
    room = connection.initJitsiConference('1', {});

    room.on('conference.trackAdded', onRemoteTrack);


    room.on('conference.userJoined', id => {
        console.log("----------Listen User Joined: ", id)
        remoteTracks[id] = [];
    });
    
    room.join();
}

JitsiMeetJS.init({});

connection = new JitsiMeetJS.JitsiConnection(options);

connection.addEventListener(
    'connection.connectionEstablished',
    onConnectionSuccess);

connection.connect();
