const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const CryptoJS = require('crypto-js');
const medicalScribeRoutes = require('./routes/medicalScribe');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/audit.log', maxsize: 5242880, maxFiles: 100 }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY missing! Exiting.');
  process.exit(1);
}
const encrypt = (text) => {
  if (!text || text.trim() === '') return encrypt('Anonymous');
  return CryptoJS.AES.encrypt(text.trim(), ENCRYPTION_KEY).toString();
};
const decrypt = (ciphertext) => {
  if (!ciphertext) return 'Anonymous';
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    const plain = bytes.toString(CryptoJS.enc.Utf8);
    return plain || 'Anonymous';
  } catch (err) {
    auditLogger.error(`Decrypt failed: ${err.message}`);
    return 'Anonymous';
  }
};

const sanitizeForClient = (data) => {
  if (!data || typeof data !== 'object') return data;
  return { ...data };
};

const limiter = rateLimit({
  windowMs: 15 * 60 * 10000,
  max: 10000,
  message: { error: 'Too many requests' }
});
app.use(limiter);

app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true }
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json({ limit: '10kb' }));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/hci-video')
  .then(() => console.log('MongoDB connected'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

const deviceRoutes = require('./routes/devices');
const callHistoryRoutes = require('./routes/callHistory');
const roomRoutes = require('./routes/Room');

app.use('/api/devices', deviceRoutes);
app.use('/api/call-history', callHistoryRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/rooms', medicalScribeRoutes);

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
    const rawName = url.searchParams.get('participantName') || 'Anonymous';
    const participantName = decodeURIComponent(rawName).trim() || 'Anonymous';
    const role = url.searchParams.get('role') || 'user';
    
    console.log(`[ROOM] Connection: roomId=${roomId}, participantId=${participantId}, name=${participantName}, role=${role}`);
    auditLogger.info(`WS Connection: Room ${roomId} participant ${participantId}`);
    
    ws.serviceType = 'room';
    ws.roomId = roomId;
    ws.participantId = participantId;
    ws.participantName = participantName;
    ws.role = role;
    
  } else if (deviceId) {
    console.log(`[DEVICE] Device connected: ${deviceId}`);
    auditLogger.info(`WS Connection: Device ${deviceId}`);
    
    ws.serviceType = 'device';
    ws.deviceId = deviceId;
    connectedDevices.set(deviceId, ws);
  } else {
    auditLogger.warn('Connection without roomId or deviceId');
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
      auditLogger.error(`WS Parse Error: ${error.message}`);
    }
  });

  ws.on('close', () => {
    if (ws.serviceType === 'room') {
      console.log(`[ROOM] Participant disconnected: ${ws.participantId} from room ${ws.roomId}`);
      handleParticipantLeave(ws);
      auditLogger.info(`WS Disconnect: Room ${ws.roomId} participant ${ws.participantId}`);
    } else if (ws.serviceType === 'device') {
      console.log(`[DEVICE] Device disconnected: ${ws.deviceId}`);
      connectedDevices.delete(ws.deviceId);
      updateDeviceStatus(ws.deviceId, 'offline');
      auditLogger.info(`WS Disconnect: Device ${ws.deviceId}`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    auditLogger.error(`WS Error: ${error.message}`);
  });
});

async function handleRoomMessage(ws, data) {
  const type = data.type;
  const roomId = data.roomId || ws.roomId;
  const participantId = data.participantId || ws.participantId;
  const participantName = data.participantName || ws.participantName || 'Anonymous';

  console.log(`[ROOM] Message: ${type} from ${participantId} (${participantName}) in room ${roomId}`);
  auditLogger.info(`Room Action: ${type} in ${roomId} by ${participantId}`);

  switch (type) {
    case 'join-room':
      await handleJoinRoom(ws, roomId, participantId, participantName, ws.role);
      break;

    case 'leave-room':
      await handleParticipantLeave(ws);
      break;

    case 'chat-message':
      const chatSenderId = data.senderId || participantId;
      const chatSenderName = data.senderName || participantName;
      const chatMessage = data.message || '';
      const chatTimestamp = new Date().toISOString();

      await saveChatMessage(
        ws.roomId,
        chatSenderId,
        chatSenderName,
        chatMessage
      );

      const outgoingChat = {
        type: 'chat-message',
        roomId: ws.roomId,
        participantId: chatSenderId,
        senderId: chatSenderId,
        senderName: chatSenderName,
        message: chatMessage,
        timestamp: chatTimestamp
      };

      broadcastToRoom(ws.roomId, ws.participantId, outgoingChat);
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
      const now = new Date();
      const sessionId = `${roomId}-${now.getTime()}`;
      dbRoom = new Room({
        roomId,
        creator: {
          participantId,
          participantName: participantName || 'Anonymous',
          role
        },
        participants: [{
          participantId,
          participantName: participantName || 'Anonymous',
          role,
          joinedAt: now
        }],
        status: 'waiting',
        callStartTime: null,
        sessionStartTime: now,
        sessionId,
        callEndTime: null,
        callDuration: 0,
        metadata: {
          totalParticipants: 1,
          maxParticipants: 2,
          reconnections: 0
        }
      });
      await dbRoom.save();
      console.log(`[ROOM] Database room created: ${roomId}`);
    } else {
      if (dbRoom.status === 'ended') {
        const now = new Date();
        const sessionId = `${roomId}-${now.getTime()}`;
        dbRoom.participants = [];
        dbRoom.callStartTime = null;
        dbRoom.callEndTime = null;
        dbRoom.callDuration = 0;
        dbRoom.sessionStartTime = now;
        dbRoom.sessionId = sessionId;
        dbRoom.status = 'waiting';
       if (dbRoom.metadata) {
          dbRoom.metadata.totalParticipants = 0;
          dbRoom.metadata.reconnections = 0;
        }
      }

      const existingParticipant = dbRoom.participants.find(p => p.participantId === participantId);
      if (!existingParticipant) {
        dbRoom.addParticipant(participantId, participantName || 'Anonymous', role);
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

      let messages = dbRoom.chatMessages || [];
      const decryptedMessages = messages.map(m => ({
        senderId: m.senderId,
        senderName: decrypt(m.senderName),
        message: decrypt(m.message),
        timestamp: m.timestamp,
        sessionId: m.sessionId
      }));
      ws.send(JSON.stringify({
        type: 'chat-history',
        roomId,
        chatMessages: decryptedMessages,
        totalMessages: decryptedMessages.length
      }));
    } else {
      const [otherParticipantId, otherWs] = existingParticipants[0];

      if (dbRoom.status === 'waiting') {
        const now = new Date();
        dbRoom.callStartTime = now;
        if (!dbRoom.sessionStartTime) {
          dbRoom.sessionStartTime = now;
        }
        dbRoom.status = 'active';
        await dbRoom.save();
        console.log(`[ROOM] Call started in room ${roomId}`);
      }

      // Plain names (ws has plain)
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

      let messages = dbRoom.chatMessages || [];
      const decryptedMessages = messages.map(m => ({
        senderId: m.senderId,
        senderName: decrypt(m.senderName),
        message: decrypt(m.message),
        timestamp: m.timestamp,
        sessionId: m.sessionId
      }));
      ws.send(JSON.stringify({
        type: 'chat-history',
        roomId,
        chatMessages: decryptedMessages,
        totalMessages: decryptedMessages.length
      }));

      otherWs.send(JSON.stringify({
        type: 'participant-joined',
        participantId,
        participantName,
        role
      }));
    }
    auditLogger.info(`Room Joined: ${roomId} by ${participantId}`);
  } catch (error) {
    console.error('[ROOM] Error in handleJoinRoom:', error);
    auditLogger.error(`Room Join Error: ${error.message} in ${roomId}`);
  }
}

function handleAdminMediaControl(ws, data) {
  if (ws.role !== 'admin') {
    auditLogger.warn(`Unauthorized media control: ${ws.participantId} in ${ws.roomId}`);
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
    auditLogger.info(`Media Control: ${ws.participantId} -> ${targetParticipantId} (${mediaType}=${enabled})`);
  }
}

async function handleParticipantLeave(ws) {
  if (ws.leftHandled) return;
  ws.leftHandled = true;

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

        // dbRoom.chatMessages = [];

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
    auditLogger.info(`Participant Left: ${ws.participantId} from ${ws.roomId}`);
  } catch (error) {
    console.error('[ROOM] Error in handleParticipantLeave:', error);
    auditLogger.error(`Participant Leave Error: ${error.message}`);
  }
}

function broadcastToRoom(roomId, senderId, data, includeSender = false) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.participants.forEach((ws, participantId) => {
    if ((includeSender || participantId !== senderId) && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(sanitizeForClient(data)));
    }
  });
}

async function saveChatMessage(roomId, senderId, senderName, message) {
  try {
    const dbRoom = await Room.findOne({ roomId });
    if (dbRoom) {
      dbRoom.addChatMessage(senderId, senderName || 'Anonymous', message || '');
      await dbRoom.save();
      console.log(`[ROOM] Chat message saved to room ${roomId}`);
      auditLogger.info(`Chat Message Saved: room ${roomId} by ${senderId}`);
    }
  } catch (error) {
    console.error('[ROOM] Error saving chat message:', error);
    auditLogger.error(`Chat Save Error: ${error.message}`);
  }
}

function handleDeviceMessage(ws, data) {
  const { type, targetDeviceId, ...payload } = data;
  
  if (payload.deviceName) payload.deviceName = payload.deviceName.trim() || 'Anonymous';
  
  console.log(`[DEVICE] Message type: ${type}, target: ${targetDeviceId}`);
  auditLogger.info(`Device Action: ${type} from ${ws.deviceId} to ${targetDeviceId}`);
  
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
        const sanitizedPayload = sanitizeForClient({ ...payload });
        targetWs.send(JSON.stringify({ 
          type, 
          fromDeviceId: ws.deviceId,
          ...sanitizedPayload 
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
    auditLogger.info(`Device Status Update: ${deviceId} to ${status}`);
  } catch (error) {
    console.error('[DEVICE] Failed to update device status:', error);
    auditLogger.error(`Device Status Error: ${error.message}`);
  }
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});