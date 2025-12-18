const mongoose = require('mongoose');
const CryptoJS = require('crypto-js');

const roomSchema = new mongoose.Schema({
  roomId: { 
    type: String, 
    required: true, 
    unique: true 
  },
   creator: {
    participantId: { type: String, required: true },
    participantName: { type: String, required: true },
    role: { type: String, enum: ['admin', 'user'], default: 'user' }
  },
  participants: [{
    participantId: { type: String, required: true },
    participantName: { type: String, required: true },
    role: { type: String, enum: ['admin', 'user'], default: 'user' },
    joinedAt: { type: Date, default: Date.now },
    leftAt: { type: Date }
  }],
  status: { 
    type: String, 
    enum: ['waiting', 'active', 'ended'], 
    default: 'waiting' 
  },
  callStartTime: { 
    type: Date 
  },
  sessionStartTime: {
    type: Date
  },
  sessionId: {
    type: String
  },
  callEndTime: { 
    type: Date 
  },
  callDuration: { 
    type: Number, 
    default: 0 
  },
  chatMessages: [{
    senderId: { type: String, required: true },
    senderName: { type: String, required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    sessionId: { type: String }
  }],
  metadata: {
    totalParticipants: { type: Number, default: 0 },
    maxParticipants: { type: Number, default: 2 },
    reconnections: { type: Number, default: 0 }
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

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const encrypt = (text) => {
  const safeText = (text || 'Anonymous').trim();
  if (safeText.length === 0) return encrypt('Anonymous');
  return CryptoJS.AES.encrypt(safeText, ENCRYPTION_KEY).toString();
};
const decrypt = (ciphertext) => {
  if (!ciphertext) return 'Anonymous';
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    const plain = bytes.toString(CryptoJS.enc.Utf8).trim();
    return plain.length > 0 ? plain : 'Anonymous';
  } catch (err) {
    return 'Anonymous';
  }
};

roomSchema.pre('save', function(next) {
  if (this.isModified('creator.participantName')) {
    this.creator.participantName = encrypt(this.creator.participantName);
  }
  if (this.isModified('participants')) {
    this.participants.forEach(p => {
      p.participantName = encrypt(p.participantName);
    });
  }
  if (this.isModified('chatMessages')) {
    this.chatMessages.forEach(m => {
      m.senderName = encrypt(m.senderName);
      m.message = encrypt(m.message);
    });
  }
  next();
});

roomSchema.post('findOne', function(doc) {
  if (doc) decryptPHI(doc);
});
roomSchema.post('find', function(docs) {
  docs.forEach(decryptPHI);
});
// Ensure any saved document we send back in responses is decrypted in memory
roomSchema.post('save', function(doc) {
  if (doc) decryptPHI(doc);
});
// Decrypt results of findOneAndUpdate (used by several REST routes)
roomSchema.post('findOneAndUpdate', function(doc) {
  if (doc) decryptPHI(doc);
});
function decryptPHI(doc) {
  if (doc.creator) doc.creator.participantName = decrypt(doc.creator.participantName);
  doc.participants.forEach(p => { p.participantName = decrypt(p.participantName); });
  doc.chatMessages.forEach(m => {
    m.senderName = decrypt(m.senderName);
    m.message = decrypt(m.message);
  });
}

roomSchema.methods.addParticipant = function(participantId, participantName, role = 'user') {
  const existing = this.participants.find(p => p.participantId === participantId);
  if (!existing) {
    this.participants.push({
      participantId,
      participantName: participantName || 'Anonymous',
      role,
      joinedAt: new Date()
    });
    this.metadata.totalParticipants = this.participants.length;
  }
};

roomSchema.methods.addChatMessage = function(senderId, senderName, message) {
  this.chatMessages.push({
    senderId,
    senderName: senderName || 'Anonymous',
    message: message || '',
    timestamp: new Date(),
    sessionId: this.sessionId
  });
};

// Mark a participant as having left the room (used by WebSocket leave handling)
roomSchema.methods.removeParticipant = function(participantId) {
  const participant = this.participants.find(p => p.participantId === participantId);
  if (participant) {
    if (!participant.participantName) {
      participant.participantName = 'Anonymous';
    }
    if (!participant.leftAt) {
      participant.leftAt = new Date();
    }
  }
};

// Compute callDuration in seconds from callStartTime / callEndTime
roomSchema.methods.calculateDuration = function() {
  if (this.callStartTime && this.callEndTime) {
    const ms = this.callEndTime.getTime() - this.callStartTime.getTime();
    this.callDuration = ms > 0 ? Math.floor(ms / 1000) : 0;
  } else {
    this.callDuration = 0;
  }
};

module.exports = mongoose.model('Room', roomSchema);