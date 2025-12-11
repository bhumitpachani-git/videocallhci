const mongoose = require('mongoose');

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
    timestamp: { type: Date, default: Date.now }
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

roomSchema.index({ roomId: 1 });
roomSchema.index({ 'creator.participantId': 1 });
roomSchema.index({ createdAt: -1 });
roomSchema.index({ status: 1 });

roomSchema.methods.calculateDuration = function() {
  if (this.callStartTime && this.callEndTime) {
    this.callDuration = Math.floor((this.callEndTime - this.callStartTime) / 1000);
  }
  return this.callDuration;
};

roomSchema.methods.addParticipant = function(participantId, participantName, role = 'user') {
  const existing = this.participants.find(p => p.participantId === participantId);
  if (!existing) {
    this.participants.push({
      participantId,
      participantName,
      role,
      joinedAt: new Date()
    });
    this.metadata.totalParticipants = this.participants.length;
  }
};

roomSchema.methods.removeParticipant = function(participantId) {
  const participant = this.participants.find(p => p.participantId === participantId);
  if (participant && !participant.leftAt) {
    participant.leftAt = new Date();
  }
};

roomSchema.methods.addChatMessage = function(senderId, senderName, message) {
  this.chatMessages.push({
    senderId,
    senderName,
    message,
    timestamp: new Date()
  });
};

module.exports = mongoose.model('Room', roomSchema);