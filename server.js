const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/hci-video')
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

const deviceRoutes = require('./routes/devices');
const callHistoryRoutes = require('./routes/callHistory');

app.use('/api/devices', deviceRoutes);
app.use('/api/call-history', callHistoryRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

const rooms = new Map(); 
const connectedDevices = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `ws://${req.headers.host || 'localhost'}`);
  
  const roomId = url.searchParams.get('roomId');
  const deviceId = url.searchParams.get('deviceId');
  
  if (roomId) {
    const participantId = url.searchParams.get('participantId');
    const participantName = decodeURIComponent(url.searchParams.get('participantName') || 'Anonymous');
    
    console.log(`[ROOM] Connection: roomId=${roomId}, participantId=${participantId}, name=${participantName}`);
    
    ws.serviceType = 'room';
    ws.roomId = roomId;
    ws.participantId = participantId;
    ws.participantName = participantName;
    
  } else if (deviceId) {
    console.log(`[DEVICE] Device connected: ${deviceId}`);
    
    ws.serviceType = 'device';
    ws.deviceId = deviceId;
    connectedDevices.set(deviceId, ws);
  } else {
    console.warn('Connection without roomId or deviceId');
    ws.close();
    return;
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (ws.serviceType === 'room') {
        handleRoomMessage(ws, data);
      } else if (ws.serviceType === 'device') {
        handleDeviceMessage(ws, data);
      }
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    if (ws.serviceType === 'room') {
      console.log(`[ROOM] Participant disconnected: ${ws.participantId} from room ${ws.roomId}`);
      handleParticipantLeave(ws);
    } else if (ws.serviceType === 'device') {
      console.log(`[DEVICE] Device disconnected: ${ws.deviceId}`);
      connectedDevices.delete(ws.deviceId);
      updateDeviceStatus(ws.deviceId, 'offline');
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});


function handleRoomMessage(ws, data) {
  const { type, roomId, participantId, participantName } = data;
  console.log(`[ROOM] Message: ${type} from ${participantId} in room ${roomId}`);

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
      console.log('[ROOM] Unknown message type:', type);
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
  console.log(`[ROOM] Room ${roomId} now has ${room.participants.size} participants`);

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
  console.log(`[ROOM] Room ${ws.roomId} now has ${room.participants.size} participants`);

  room.participants.forEach((otherWs) => {
    otherWs.send(JSON.stringify({
      type: 'participant-left',
      participantId: ws.participantId
    }));
  });

  if (room.participants.size === 0) {
    rooms.delete(ws.roomId);
    console.log(`[ROOM] Room ${ws.roomId} deleted (empty)`);
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


function handleDeviceMessage(ws, data) {
  const { type, targetDeviceId, ...payload } = data;
  
  console.log(`[DEVICE] Message type: ${type}, target: ${targetDeviceId}`);
  
  switch (type) {
    case 'register':
      ws.deviceId = payload.deviceId;
      connectedDevices.set(payload.deviceId, ws);
      console.log(`[DEVICE] Device registered: ${payload.deviceId}`);
      updateDeviceStatus(payload.deviceId, 'online');
      ws.send(JSON.stringify({ 
        type: 'registered', 
        deviceId: payload.deviceId 
      }));
      break;
      
    case 'call-initiate':
    case 'call-accept':
    case 'call-reject':
    case 'call-busy':
    case 'call-end':
    case 'call-missed':
    case 'chat-message':
    case 'webrtc-offer':
    case 'webrtc-answer':
    case 'webrtc-ice-candidate':
      if (!targetDeviceId) {
        console.error(`[DEVICE] Missing targetDeviceId for ${type}`);
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Missing targetDeviceId' 
        }));
        return;
      }
      
      const targetWs = connectedDevices.get(targetDeviceId);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ 
          type, 
          fromDeviceId: ws.deviceId,
          ...payload 
        }));
        console.log(`[DEVICE] Forwarded ${type} to ${targetDeviceId}`);
      } else {
        console.log(`[DEVICE] Target device ${targetDeviceId} not connected`);
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: `Device ${targetDeviceId} is not connected` 
        }));
      }
      break;
      
    default:
      console.log('[DEVICE] Unknown message type:', type);
  }
}

async function updateDeviceStatus(deviceId, status) {
  try {
    const Device = require('./models/Device');
    await Device.findOneAndUpdate(
      { deviceId: deviceId },
      { status: status, updatedAt: Date.now() }
    );
    console.log(`[DEVICE] Device ${deviceId} status updated to ${status}`);
  } catch (error) {
    console.error('[DEVICE] Failed to update device status:', error);
  }
}


const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log('Services:');
  console.log('  - Room-based calls: ws://localhost:${PORT}?roomId=XXX&participantId=YYY&participantName=ZZZ');
  console.log('  - Device-to-device: ws://localhost:${PORT}?deviceId=XXX');
});