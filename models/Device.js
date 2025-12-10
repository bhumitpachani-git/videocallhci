const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  floor: { 
    type: String, 
    required: true 
  },
  room: { 
    type: String, 
    required: true 
  },
  deviceName: { 
    type: String, 
    required: true 
  },
  deviceId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  status: { 
    type: String, 
    enum: ['online', 'offline', 'busy'], 
    default: 'offline' 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// MongoDB automatically creates _id field (ObjectId)
module.exports = mongoose.model('Device', deviceSchema);