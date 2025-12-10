const mongoose = require('mongoose');

// Device Usage sub-schema
const deviceUsageSchema = new mongoose.Schema({
  cpuUsage: { type: Number, default: 0 },      // percentage 0-100
  ramUsage: { type: Number, default: 0 },      // percentage 0-100
  ramTotal: { type: Number, default: 0 },      // in MB
  ramUsed: { type: Number, default: 0 },       // in MB
  networkUp: { type: Number, default: 0 },     // in KB/s
  networkDown: { type: Number, default: 0 },   // in KB/s
  batteryLevel: { type: Number }               // percentage 0-100 (optional)
}, { _id: false });

const callHistorySchema = new mongoose.Schema({
  callerId: { 
    type: String, 
    required: true 
  },
  callerName: { 
    type: String, 
    required: true 
  },
  receiverId: { 
    type: String, 
    required: true 
  },
  receiverName: { 
    type: String, 
    required: true 
  },
  startTime: { 
    type: Date, 
    required: true 
  },
  endTime: { 
    type: Date 
  },
  duration: { 
    type: Number, 
    default: 0  // in seconds
  },
  status: { 
    type: String, 
    enum: ['completed', 'missed', 'rejected', 'busy'], 
    required: true 
  },
  date: {
    type: Date, 
    default: Date.now 
  },
  // Device usage metrics at time of call
  callerUsage: deviceUsageSchema,
  receiverUsage: deviceUsageSchema
});

// MongoDB automatically creates _id field (ObjectId)
module.exports = mongoose.model('CallHistory', callHistorySchema);