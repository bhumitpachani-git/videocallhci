const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  participantId: {
    type: String,
    required: true
  },
  participantName: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['admin', 'user'],
    default: 'user'
  },
  joinedAt: {
    type: Date,
    default: Date.now
  },
  leftAt: {
    type: Date,
    default: null
  }
});

const chatMessageSchema = new mongoose.Schema({
  senderId: {
    type: String,
    required: true
  },
  senderName: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  sessionId: {
    type: String,
    default: null
  }
});

const callRecordingSchema = new mongoose.Schema({
  fileName: {
    type: String,
    required: true
  },
  s3Key: {
    type: String,
    required: true,
    index: true
  },
  s3Url: {
    type: String,
    required: true
  },
  s3Bucket: {
    type: String,
    required: true
  },
  fileSize: {
    type: Number,
    required: true
  },
  mimeType: {
    type: String,
    required: true
  },
  startedBy: {
    type: String,
    required: true
  },
  uploadedBy: {
    type: String,
    required: true
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  },
  startTime: {
    type: Date,
    default: null
  },
  endTime: {
    type: Date,
    default: null
  },
  duration: {
    type: Number,
    default: 0
  },
  MedicalScribeJobName: {
    type: String,
    default: null
  },
  MedicaltxtURL: {
    type: String,
    default: null
  }
});

const roomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  sessionId: {
    type: String,
    default: null
  },
  creator: {
    participantId: {
      type: String,
      required: true
    },
    participantName: {
      type: String,
      required: true
    },
    role: {
      type: String,
      enum: ['admin', 'user'],
      default: 'admin'
    }
  },
  participants: [participantSchema],
  chatMessages: [chatMessageSchema],
  callRecordings: [callRecordingSchema],
  status: {
    type: String,
    enum: ['waiting', 'active', 'ended'],
    default: 'waiting',
    index: true
  },
  callStartTime: {
    type: Date,
    default: null
  },
  callEndTime: {
    type: Date,
    default: null
  },
  callDuration: {
    type: Number,
    default: 0
  },
  metadata: {
    totalParticipants: {
      type: Number,
      default: 0
    },
    maxParticipants: {
      type: Number,
      default: 2
    }
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

roomSchema.methods.addParticipant = function(participantId, participantName, role = 'user') {
  const exists = this.participants.some(p => p.participantId === participantId);
  if (!exists) {
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

roomSchema.methods.calculateDuration = function() {
  if (this.callStartTime && this.callEndTime) {
    this.callDuration = Math.floor((this.callEndTime - this.callStartTime) / 1000);
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

roomSchema.methods.addCallRecording = function(s3Key, s3Url, s3Bucket, fileName, fileSize, mimeType, startedBy, uploadedBy, startTime, endTime, duration) {
  this.callRecordings.push({
    fileName,
    s3Key,
    s3Url,
    s3Bucket,
    fileSize,
    mimeType,
    startedBy,
    uploadedBy,
    uploadedAt: new Date(),
    startTime,
    endTime,
    duration
  });
};

roomSchema.index({ 'creator.participantId': 1 });
roomSchema.index({ status: 1, createdAt: -1 });
roomSchema.index({ 'callRecordings.s3Key': 1 });

module.exports = mongoose.model('Room', roomSchema);