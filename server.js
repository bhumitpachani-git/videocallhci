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

const connectedDevices = new Map();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `ws://${req.headers.host}`);
  const deviceId = url.searchParams.get('deviceId');
  
  console.log(`Device connected: ${deviceId}`);
  
  if (deviceId) {
    connectedDevices.set(deviceId, ws);
    ws.deviceId = deviceId;
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleWebSocketMessage(ws, data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    if (ws.deviceId) {
      connectedDevices.delete(ws.deviceId);
      updateDeviceStatus(ws.deviceId, 'offline');
      console.log(`Device disconnected: ${ws.deviceId}`);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function handleWebSocketMessage(ws, data) {
  const { type, targetDeviceId, ...payload } = data;
  
  console.log(`Message type: ${type}, target: ${targetDeviceId}`);
  
  switch (type) {
    case 'register':
      ws.deviceId = payload.deviceId;
      connectedDevices.set(payload.deviceId, ws);
      console.log(`Device registered: ${payload.deviceId}`);
      updateDeviceStatus(payload.deviceId, 'online');
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
        console.error(`Missing targetDeviceId for ${type}`);
        return;
      }
      const targetWs = connectedDevices.get(targetDeviceId);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({ type, ...payload }));
        console.log(`Forwarded ${type} to ${targetDeviceId}`);
      } else {
        console.log(`Target device ${targetDeviceId} not connected`);
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: `Device ${targetDeviceId} is not connected` 
        }));
      }
      break;
      
    default:
      console.log('Unknown message type:', type);
  }
}

async function updateDeviceStatus(deviceId, status) {
  try {
    const Device = require('./models/Device');
    await Device.findOneAndUpdate(
      { deviceId: deviceId },
      { status: status, updatedAt: Date.now() }
    );
    console.log(`Device ${deviceId} status updated to ${status}`);
  } catch (error) {
    console.error('Failed to update device status:', error);
  }
}

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
});