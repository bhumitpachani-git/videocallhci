const mongoose = require('mongoose');
const CryptoJS = require('crypto-js');

const deviceUsageSchema = new mongoose.Schema({
  cpuUsage: { type: Number, default: 0 },
  ramUsage: { type: Number, default: 0 },
  ramTotal: { type: Number, default: 0 },
  ramUsed: { type: Number, default: 0 },
  networkUp: { type: Number, default: 0 },
  networkDown: { type: Number, default: 0 },
  batteryLevel: { type: Number }
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
    default: 0
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
  callerUsage: deviceUsageSchema,
  receiverUsage: deviceUsageSchema
});

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const encrypt = (text) => {
  const safe = (text || '').trim();
  if (!safe) return '';
  return CryptoJS.AES.encrypt(safe, ENCRYPTION_KEY).toString();
};
const decrypt = (ciphertext) => {
  if (!ciphertext) return '';
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, ENCRYPTION_KEY);
    return bytes.toString(CryptoJS.enc.Utf8);
  } catch (err) {
    return '';
  }
};

callHistorySchema.pre('save', function(next) {
  if (this.isModified('callerName') && this.callerName) {
    this.callerName = encrypt(this.callerName);
  }
  if (this.isModified('receiverName') && this.receiverName) {
    this.receiverName = encrypt(this.receiverName);
  }
  next();
});

callHistorySchema.post('findOne', function(doc) {
  if (doc) {
    if (doc.callerName) doc.callerName = decrypt(doc.callerName);
    if (doc.receiverName) doc.receiverName = decrypt(doc.receiverName);
  }
});
callHistorySchema.post('find', function(docs) {
  docs.forEach(doc => {
    if (doc.callerName) doc.callerName = decrypt(doc.callerName);
    if (doc.receiverName) doc.receiverName = decrypt(doc.receiverName);
  });
});
callHistorySchema.post('save', function(doc) {
  if (doc) {
    if (doc.callerName) doc.callerName = decrypt(doc.callerName);
    if (doc.receiverName) doc.receiverName = decrypt(doc.receiverName);
  }
});
callHistorySchema.post('findOneAndUpdate', function(doc) {
  if (doc) {
    if (doc.callerName) doc.callerName = decrypt(doc.callerName);
    if (doc.receiverName) doc.receiverName = decrypt(doc.receiverName);
  }
});

module.exports = mongoose.model('CallHistory', callHistorySchema);