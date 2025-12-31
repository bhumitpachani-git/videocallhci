const mongoose = require('mongoose');
const CryptoJS = require('crypto-js');

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

deviceSchema.pre('save', function(next) {
  if (this.isModified('deviceName') && this.deviceName) {
    this.deviceName = encrypt(this.deviceName);
  }
  next();
});

deviceSchema.post('findOne', function(doc) {
  if (doc && doc.deviceName) doc.deviceName = decrypt(doc.deviceName);
});
deviceSchema.post('find', function(docs) {
  docs.forEach(doc => {
    if (doc.deviceName) doc.deviceName = decrypt(doc.deviceName);
  });
});
deviceSchema.post('save', function(doc) {
  if (doc && doc.deviceName) doc.deviceName = decrypt(doc.deviceName);
});
deviceSchema.post('findOneAndUpdate', function(doc) {
  if (doc && doc.deviceName) doc.deviceName = decrypt(doc.deviceName);
});

module.exports = mongoose.model('Device', deviceSchema);