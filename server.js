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
const roomRoutes = require('./routes/Room');

app.use('/api/devices', deviceRoutes);
app.use('/api/call-history', callHistoryRoutes);
app.use('/api/rooms', roomRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

const rooms = new Map(); 
const connectedDevices = new Map();
const Room = require('./models/Room');

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `ws://${req.headers.host || 'localhost'}`);
  
  const roomId = url.searchParams.get('roomId');
  const deviceId = url.searchParams.get('deviceId');
  
  if (roomId) {
    const participantId = url.searchParams.get('participantId');
    const participantName = decodeURIComponent(url.searchParams.get('participantName') || 'Anonymous');
    const role = url.searchParams.get('role') || 'user';
    
    console.log(`[ROOM] Connection: roomId=${roomId}, participantId=${participantId}, name=${participantName}, role=${role}`);
    
    ws.serviceType = 'room';
    ws.roomId = roomId;
    ws.participantId = participantId;
    ws.participantName = participantName;
    ws.role = role;
    
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


async function handleRoomMessage(ws, data) {
  const { type, roomId, participantId, participantName } = data;
  console.log(`[ROOM] Message: ${type} from ${participantId} in room ${roomId}`);

  switch (type) {
    case 'join-room':
      await handleJoinRoom(ws, roomId, participantId, participantName, ws.role);
      break;

    case 'leave-room':
      await handleParticipantLeave(ws);
      break;

    case 'chat-message':
      await saveChatMessage(ws.roomId, data.senderId, data.senderName, data.message);
      broadcastToRoom(ws.roomId, ws.participantId, data);
      break;

    case 'webrtc-offer':
    case 'webrtc-answer':
    case 'webrtc-ice-candidate':
      broadcastToRoom(ws.roomId, ws.participantId, data);
      break;

    case 'admin-control-media':
      handleAdminMediaControl(ws, data);
      break;

    default:
      console.log('[ROOM] Unknown message type:', type);
  }
}

async function handleJoinRoom(ws, roomId, participantId, participantName, role) {
  try {
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

    let dbRoom = await Room.findOne({ roomId });
    
    if (!dbRoom) {
      dbRoom = new Room({
        roomId,
        creator: {
          participantId,
          participantName,
          role
        },
        participants: [{
          participantId,
          participantName,
          role,
          joinedAt: new Date()
        }],
        status: 'waiting',
        metadata: {
          totalParticipants: 1,
          maxParticipants: 2
        }
      });
      await dbRoom.save();
      console.log(`[ROOM] Database room created: ${roomId}`);
    } else {
      const existingParticipant = dbRoom.participants.find(p => p.participantId === participantId);
      if (!existingParticipant) {
        dbRoom.addParticipant(participantId, participantName, role);
        await dbRoom.save();
      }
    }

    const existingParticipants = Array.from(room.participants.entries());

    room.participants.set(participantId, ws);
    console.log(`[ROOM] Room ${roomId} now has ${room.participants.size} participants`);

    if (existingParticipants.length === 0) {
      ws.send(JSON.stringify({
        type: 'room-status',
        status: 'waiting',
        roomId,
        role
      }));
    } else {
      const [otherParticipantId, otherWs] = existingParticipants[0];

      if (dbRoom.status === 'waiting') {
        dbRoom.callStartTime = new Date();
        dbRoom.status = 'active';
        await dbRoom.save();
        console.log(`[ROOM] Call started in room ${roomId}`);
      }

      ws.send(JSON.stringify({
        type: 'room-status',
        status: 'ready',
        roomId,
        role,
        otherParticipant: {
          id: otherParticipantId,
          name: otherWs.participantName,
          role: otherWs.role
        }
      }));

      otherWs.send(JSON.stringify({
        type: 'participant-joined',
        participantId,
        participantName,
        role
      }));
    }
  } catch (error) {
    console.error('[ROOM] Error in handleJoinRoom:', error);
  }
}

function handleAdminMediaControl(ws, data) {
  if (ws.role !== 'admin') {
    console.warn(`[ROOM] Non-admin ${ws.participantId} tried to control media`);
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Only admins can control participant media'
    }));
    return;
  }

  const { targetParticipantId, mediaType, enabled } = data;
  console.log(`[ROOM] Admin ${ws.participantId} controlling ${targetParticipantId}'s ${mediaType}: ${enabled}`);

  const room = rooms.get(ws.roomId);
  if (!room) return;

  const targetWs = room.participants.get(targetParticipantId);
  if (targetWs && targetWs.readyState === WebSocket.OPEN) {
    targetWs.send(JSON.stringify({
      type: 'admin-media-control',
      mediaType,
      enabled,
      fromAdmin: ws.participantId
    }));
    console.log(`[ROOM] Media control sent to ${targetParticipantId}`);
  }
}

async function handleParticipantLeave(ws) {
  if (!ws.roomId || !ws.participantId) return;

  try {
    const room = rooms.get(ws.roomId);
    if (!room) return;

    room.participants.delete(ws.participantId);
    console.log(`[ROOM] Room ${ws.roomId} now has ${room.participants.size} participants`);

    const dbRoom = await Room.findOne({ roomId: ws.roomId });
    if (dbRoom) {
      dbRoom.removeParticipant(ws.participantId);

      const activeParticipants = room.participants.size;

      if (activeParticipants === 0 && dbRoom.status === 'active') {
        dbRoom.callEndTime = new Date();
        dbRoom.calculateDuration();
        dbRoom.status = 'ended';
        console.log(`[ROOM] Call ended in room ${ws.roomId}, duration: ${dbRoom.callDuration}s`);
      }

      dbRoom.updatedAt = new Date();
      await dbRoom.save();
    }

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
  } catch (error) {
    console.error('[ROOM] Error in handleParticipantLeave:', error);
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

async function saveChatMessage(roomId, senderId, senderName, message) {
  try {
    const dbRoom = await Room.findOne({ roomId });
    if (dbRoom) {
      dbRoom.addChatMessage(senderId, senderName, message);
      await dbRoom.save();
      console.log(`[ROOM] Chat message saved to room ${roomId}`);
    }
  } catch (error) {
    console.error('[ROOM] Error saving chat message:', error);
  }
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
  console.log('API Endpoints:');
  console.log('  - Devices: /api/devices');
  console.log('  - Call History: /api/call-history');
  console.log('  - Rooms: /api/rooms');
  console.log('WebSocket Services:');
  console.log('  - Room-based calls: ws://localhost:${PORT}?roomId=XXX&participantId=YYY&participantName=ZZZ&role=admin|user');
  console.log('  - Device-to-device: ws://localhost:${PORT}?deviceId=XXX');
});