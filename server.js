const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/hci-video')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Routes
const deviceRoutes = require('./routes/devices');
const callHistoryRoutes = require('./routes/callHistory');

app.use('/api/devices', deviceRoutes);
app.use('/api/call-history', callHistoryRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});


const rooms = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('roomId');
  const participantId = url.searchParams.get('participantId');
  const participantName = decodeURIComponent(url.searchParams.get('participantName') || 'Anonymous');

  console.log(`Connection: roomId=${roomId}, participantId=${participantId}, name=${participantName}`);

  ws.roomId = roomId;
  ws.participantId = participantId;
  ws.participantName = participantName;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleRoomMessage(ws, data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    console.log(`Participant disconnected: ${ws.participantId} from room ${ws.roomId}`);
    handleParticipantLeave(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function handleRoomMessage(ws, data) {
  const { type, roomId, participantId, participantName } = data;
  console.log(`Message: ${type} from ${participantId} in room ${roomId}`);

  switch (type) {
    case 'join-room':
      handleJoinRoom(ws, roomId, participantId, participantName);
      break;

    case 'leave-room':
      handleParticipantLeave(ws);
      break;

    case 'chat-message':
    case 'webrtc-offer':
    case 'webrtc-answer':
    case 'webrtc-ice-candidate':
      broadcastToRoom(ws.roomId, ws.participantId, data);
      break;

    default:
      console.log('Unknown message type:', type);
  }
}

function handleJoinRoom(ws, roomId, participantId, participantName) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { participants: new Map() });
  }

  const room = rooms.get(roomId);

  if (room.participants.size >= 2) {
    ws.send(JSON.stringify({
      type: 'room-status',
      status: 'full',
      roomId
    }));
    return;
  }

  const existingParticipants = Array.from(room.participants.entries());

  room.participants.set(participantId, ws);
  console.log(`Room ${roomId} now has ${room.participants.size} participants`);

  if (existingParticipants.length === 0) {
    ws.send(JSON.stringify({
      type: 'room-status',
      status: 'waiting',
      roomId
    }));
  } else {
    const [otherParticipantId, otherWs] = existingParticipants[0];

    ws.send(JSON.stringify({
      type: 'room-status',
      status: 'ready',
      roomId,
      otherParticipant: {
        id: otherParticipantId,
        name: otherWs.participantName
      }
    }));

    otherWs.send(JSON.stringify({
      type: 'participant-joined',
      participantId,
      participantName
    }));
  }
}

function handleParticipantLeave(ws) {
  if (!ws.roomId || !ws.participantId) return;

  const room = rooms.get(ws.roomId);
  if (!room) return;

  room.participants.delete(ws.participantId);
  console.log(`Room ${ws.roomId} now has ${room.participants.size} participants`);

  room.participants.forEach((otherWs) => {
    otherWs.send(JSON.stringify({
      type: 'participant-left',
      participantId: ws.participantId
    }));
  });

  if (room.participants.size === 0) {
    rooms.delete(ws.roomId);
    console.log(`Room ${ws.roomId} deleted (empty)`);
  }
}

function broadcastToRoom(roomId, senderId, data) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.participants.forEach((ws, participantId) => {
    if (participantId !== senderId && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
});