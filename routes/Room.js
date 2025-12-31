const express = require('express');
const router = express.Router();
const Joi = require('joi');
const Room = require('../models/Room');
const multer = require('multer');
const winston = require('winston');
const CryptoJS = require('crypto-js');
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk');

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

const S3_BUCKET_NAME = 'hcishare';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'recordings/temp';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + '.' + file.originalname.split('.').pop());
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'video/mp4', 
      'video/webm', 
      'video/ogg', 
      'video/x-matroska',
      'audio/webm', 
      'audio/mp3', 
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'application/octet-stream'
    ];
    
    const allowedExtensions = ['.mp4', '.webm', '.ogg', '.mkv', '.mp3', '.wav', '.m4a'];
    const fileExtension = file.originalname ? path.extname(file.originalname).toLowerCase() : '';
    
    if (allowedMimes.includes(file.mimetype) || allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      auditLogger.error(`File upload rejected: ${file.originalname}, MIME: ${file.mimetype}`);
      cb(new Error(`Invalid file type. Received: ${file.mimetype}. Only video/audio files are allowed.`));
    }
  }
});

const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
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

const uploadToS3 = async (filePath, fileName, roomId) => {
  try {
    const fileContent = fs.readFileSync(filePath);
    const fileExtension = path.extname(fileName);
    const s3Key = `recordings/${roomId}/${Date.now()}-${fileName}`;
    
    const params = {
      Bucket: S3_BUCKET_NAME,
      Key: s3Key,
      Body: fileContent,
      ContentType: getContentType(fileExtension),
      ACL: 'public-read'
    };

    const uploadResult = await s3.upload(params).promise();
    
    fs.unlinkSync(filePath);
    
    return {
      s3Key: uploadResult.Key,
      s3Url: uploadResult.Location,
      bucket: S3_BUCKET_NAME
    };
  } catch (error) {
    auditLogger.error(`S3 Upload Error: ${error.message}`);
    throw new Error(`Failed to upload to S3: ${error.message}`);
  }
};

const getContentType = (extension) => {
  const contentTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.mpeg': 'audio/mpeg'
  };
  return contentTypes[extension.toLowerCase()] || 'application/octet-stream';
};

const generateSignedUrl = (s3Key, expiresIn = 3600) => {
  const params = {
    Bucket: S3_BUCKET_NAME,
    Key: s3Key,
    Expires: expiresIn
  };
  return s3.getSignedUrl('getObject', params);
};

const deleteFromS3 = async (s3Key) => {
  try {
    const params = {
      Bucket: S3_BUCKET_NAME,
      Key: s3Key
    };
    await s3.deleteObject(params).promise();
    return true;
  } catch (error) {
    auditLogger.error(`S3 Delete Error: ${error.message}`);
    return false;
  }
};

const roomSchema = Joi.object({
  roomId: Joi.string().alphanum().max(50).required(),
  creator: Joi.object({
    participantId: Joi.string().max(100).required(),
    participantName: Joi.string().min(1).max(100).required(),
    role: Joi.string().valid('admin', 'user')
  }).required()
});

const participantSchema = Joi.object({
  participantId: Joi.string().max(100).required(),
  participantName: Joi.string().min(1).max(100).required(),
  role: Joi.string().valid('admin', 'user')
});

router.get('/', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      creatorId,
      sortBy = 'createdAt',
      order = 'desc'
    } = req.query;

    const query = {};
    if (status) query.status = status;
    if (creatorId) query['creator.participantId'] = creatorId;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sortOrder = order === 'asc' ? 1 : -1;

    const rooms = await Room.find(query)
      .sort({ [sortBy]: sortOrder })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await Room.countDocuments(query);

    auditLogger.info(`Room List Access: page ${page}`);
    res.json({
      rooms,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    auditLogger.error(`Room List Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:roomId', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }
    auditLogger.info(`Room View: ${req.params.roomId}`);
    res.json(room);
  } catch (error) {
    auditLogger.error(`Room View Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:roomId/stats', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const stats = {
      roomId: room.roomId,
      status: room.status,
      creator: room.creator,
      participantCount: room.participants.length,
      activeParticipants: room.participants.filter(p => !p.leftAt).length,
      callDuration: room.callDuration,
      chatMessageCount: room.chatMessages.length,
      recordingCount: room.callRecordings ? room.callRecordings.length : 0,
      createdAt: room.createdAt,
      callStartTime: room.callStartTime,
      callEndTime: room.callEndTime,
      sessionId: room.sessionId
    };

    auditLogger.info(`Room Stats: ${req.params.roomId}`);
    res.json(stats);
  } catch (error) {
    auditLogger.error(`Room Stats Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:roomId/chat', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    let messages = room.chatMessages || [];

    const decryptedMessages = messages.map(m => ({
      senderId: m.senderId,
      senderName: decrypt(m.senderName),
      message: decrypt(m.message),
      timestamp: m.timestamp,
      sessionId: m.sessionId
    }));

    res.json({
      roomId: room.roomId,
      chatMessages: decryptedMessages,
      totalMessages: decryptedMessages.length
    });
    auditLogger.info(`Chat History: ${req.params.roomId}`);
  } catch (error) {
    auditLogger.error(`Chat History Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/creator/:participantId', async (req, res) => {
  try {
    const rooms = await Room.find({ 
      'creator.participantId': req.params.participantId 
    }).sort({ createdAt: -1 });

    res.json({
      participantId: req.params.participantId,
      rooms,
      totalRooms: rooms.length
    });
    auditLogger.info(`Creator Rooms: ${req.params.participantId}`);
  } catch (error) {
    auditLogger.error(`Creator Rooms Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/status/active', async (req, res) => {
  try {
    const activeRooms = await Room.find({ 
      status: { $in: ['waiting', 'active'] } 
    }).sort({ createdAt: -1 });

    res.json({
      activeRooms,
      count: activeRooms.length
    });
    auditLogger.info(`Active Rooms Access`);
  } catch (error) {
    auditLogger.error(`Active Rooms Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  const { error } = roomSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  try {
    const { roomId, creator } = req.body;
    creator.participantName = creator.participantName.trim() || 'Anonymous';

    const existingRoom = await Room.findOne({ roomId });
    if (existingRoom) {
      return res.status(400).json({ message: 'Room already exists' });
    }

    const room = new Room({
      roomId,
      creator,
      participants: [{
        participantId: creator.participantId,
        participantName: creator.participantName,
        role: creator.role || 'admin',
        joinedAt: new Date()
      }],
      status: 'waiting',
      metadata: {
        totalParticipants: 1,
        maxParticipants: 2
      }
    });

    const newRoom = await room.save();
    auditLogger.info(`Room Created: ${roomId}`);
    res.status(201).json(newRoom);
  } catch (error) {
    auditLogger.error(`Room Create Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.post('/:roomId/participants', async (req, res) => {
  const { error } = participantSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.participants.length >= room.metadata.maxParticipants) {
      return res.status(400).json({ message: 'Room is full' });
    }

    room.addParticipant(req.body.participantId, req.body.participantName.trim() || 'Anonymous', req.body.role);
    
    if (room.participants.length === 2 && !room.callStartTime) {
      room.callStartTime = new Date();
      room.status = 'active';
    }

    room.updatedAt = new Date();
    await room.save();
    auditLogger.info(`Participant Added: ${req.body.participantId} to ${req.params.roomId}`);

    res.json(room);
  } catch (error) {
    auditLogger.error(`Participant Add Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.post('/:roomId/chat', async (req, res) => {
  const chatSchema = Joi.object({
    senderId: Joi.string().required(),
    senderName: Joi.string().min(1).max(100).required(),
    message: Joi.string().min(1).max(1000).required()
  });
  const { error } = chatSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  try {
    const plainSenderName = req.body.senderName.trim() || 'Anonymous';
    const plainMessage = req.body.message.trim();

    const update = {
      $push: {
        chatMessages: {
          senderId: req.body.senderId,
          senderName: encrypt(plainSenderName),
          message: encrypt(plainMessage),
          timestamp: new Date()
        }
      },
      $set: { updatedAt: new Date() }
    };

    const room = await Room.findOneAndUpdate(
      { roomId: req.params.roomId },
      update,
      { new: true }
    );

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const last = room.chatMessages[room.chatMessages.length - 1];
    const decryptedChat = {
      senderId: last.senderId,
      senderName: decrypt(last.senderName),
      message: decrypt(last.message),
      timestamp: last.timestamp
    };

    res.json({
      message: 'Chat message added',
      chatMessage: decryptedChat
    });
    auditLogger.info(`Chat Added: ${req.params.roomId}`);
  } catch (error) {
    auditLogger.error(`Chat Add Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.post('/:roomId/call-recording', (req, res) => {
  upload.single('recording')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      auditLogger.error(`Multer Error: ${err.message}`);
      return res.status(400).json({ 
        message: 'File upload error',
        error: err.message 
      });
    } else if (err) {
      auditLogger.error(`Upload Error: ${err.message}`);
      return res.status(400).json({ 
        message: err.message 
      });
    }

    try {
      const room = await Room.findOne({ roomId: req.params.roomId });
      if (!room) {
        return res.status(404).json({ message: 'Room not found' });
      }

      if (!req.file) {
        return res.status(400).json({ message: 'No file uploaded' });
      }

      auditLogger.info(`File received: ${req.file.originalname}, MIME: ${req.file.mimetype}, Size: ${req.file.size}`);

      const uploadedBy = req.body.uploadedBy || 'Anonymous';
      const startedBy = req.body.startedBy || 'Anonymous';  
      const startTime = req.body.startTime ? new Date(req.body.startTime) : new Date();
      const endTime = req.body.endTime ? new Date(req.body.endTime) : new Date();
      const duration = req.body.duration || 0;

      const s3Result = await uploadToS3(req.file.path, req.file.originalname, req.params.roomId);

      const recordingData = {
        fileName: req.file.originalname,
        s3Key: s3Result.s3Key,
        s3Url: s3Result.s3Url,
        s3Bucket: s3Result.bucket,
        fileSize: req.file.size,
        mimeType: req.file.mimetype,
        startedBy: encrypt(startedBy),
        uploadedBy: encrypt(uploadedBy),
        startTime: startTime,
        endTime: endTime,
        duration: duration,
        uploadedAt: new Date()
      };

      room.callRecordings.push(recordingData);
      await room.save();

      res.json({
        message: 'Call recording uploaded successfully to S3',
        recording: {
          fileName: req.file.originalname,
          s3Url: s3Result.s3Url,
          s3Key: s3Result.s3Key,
          fileSize: req.file.size,
          mimeType: req.file.mimetype,
          startedBy: decrypt(encrypt(startedBy)),
          uploadedBy: decrypt(encrypt(uploadedBy)),
          startTime,
          endTime,
          duration
        }
      });
      auditLogger.info(`Call Recording Uploaded to S3: ${req.params.roomId} - ${s3Result.s3Key}`);
    } catch (error) {
      auditLogger.error(`Call Recording Upload Error: ${error.message}`);
      
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      
      res.status(500).json({ message: error.message || 'Server error' });
    }
  });
});

router.get('/:roomId/call-recordings', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const recordings = (room.callRecordings || []).map(r => ({
      fileName: r.fileName,
      s3Url: r.s3Url,
      s3Key: r.s3Key,
      fileSize: r.fileSize,
      mimeType: r.mimeType,
      startedBy: decrypt(r.startedBy),
      uploadedBy: decrypt(r.uploadedBy),
      uploadedAt: r.uploadedAt,
      sessionId: r.sessionId,
      startTime: r.startTime,
      endTime: r.endTime,
      duration: r.duration
    }));

    res.json({
      roomId: room.roomId,
      callRecordings: recordings,
      totalRecordings: recordings.length
    });
    auditLogger.info(`Call Recordings Retrieved: ${req.params.roomId}`);
  } catch (error) {
    auditLogger.error(`Call Recordings Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:roomId/call-recordings/:filename', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const recording = (room.callRecordings || []).find(r => r.fileName === req.params.filename);
    if (!recording) {
      return res.status(404).json({ message: 'Recording not found' });
    }
    
    res.json({
      fileName: recording.fileName,
      url: recording.s3Url, 
      s3Key: recording.s3Key,
      fileSize: recording.fileSize,
      mimeType: recording.mimeType,
      startedBy: decrypt(recording.startedBy),
      uploadedBy: decrypt(recording.uploadedBy),
      uploadedAt: recording.uploadedAt,
      duration: recording.duration
    });

    auditLogger.info(`Call Recording URL Retrieved: ${req.params.roomId}/${req.params.filename}`);
  } catch (error) {
    auditLogger.error(`Call Recording Retrieval Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:roomId/call-recordings/:filename', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const recordingIndex = room.callRecordings.findIndex(r => r.fileName === req.params.filename);
    if (recordingIndex === -1) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    const recording = room.callRecordings[recordingIndex];
    
    await deleteFromS3(recording.s3Key);
    
    room.callRecordings.splice(recordingIndex, 1);
    await room.save();

    auditLogger.info(`Recording Deleted: ${req.params.roomId}/${req.params.filename}`);
    res.json({ message: 'Recording deleted successfully' });
  } catch (error) {
    auditLogger.error(`Recording Delete Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:roomId/full-history', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const decryptedChat = (room.chatMessages || []).map(m => ({
      senderId: m.senderId,
      senderName: decrypt(m.senderName),
      message: decrypt(m.message),
      timestamp: m.timestamp,
      sessionId: m.sessionId
    }));

    const decryptedRecordings = (room.callRecordings || []).map(r => ({
      fileName: r.fileName,
      s3Url: r.s3Url,
      s3Key: r.s3Key,
      fileSize: r.fileSize,
      mimeType: r.mimeType,
      startedBy: decrypt(r.startedBy),
      uploadedBy: decrypt(r.uploadedBy),
      uploadedAt: r.uploadedAt,
      sessionId: r.sessionId,
      startTime: r.startTime,
      endTime: r.endTime,
      duration: r.duration
    }));

    res.json({
      roomId: room.roomId,
      sessionId: room.sessionId,
      participants: room.participants.map(p => ({
        participantId: p.participantId,
        participantName: decrypt(p.participantName),
        role: p.role,
        joinedAt: p.joinedAt,
        leftAt: p.leftAt
      })),
      callDetails: {
        startTime: room.callStartTime,
        endTime: room.callEndTime,
        duration: room.callDuration
      },
      chatMessages: decryptedChat,
      callRecordings: decryptedRecordings,
      totalChat: decryptedChat.length,
      totalRecordings: decryptedRecordings.length
    });
    auditLogger.info(`Full History Retrieved: ${req.params.roomId}`);
  } catch (error) {
    auditLogger.error(`Full History Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/:roomId/start-call', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.status !== 'waiting') {
      return res.status(400).json({ message: 'Call already started or ended' });
    }

    room.callStartTime = new Date();
    room.status = 'active';
    room.updatedAt = new Date();
    await room.save();

    auditLogger.info(`Call Started: ${req.params.roomId}`);
    res.json(room);
  } catch (error) {
    auditLogger.error(`Call Start Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.patch('/:roomId/end-call', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.status !== 'active') {
      return res.status(400).json({ message: 'No active call to end' });
    }

    room.callEndTime = new Date();
    room.calculateDuration();
    room.status = 'ended';

    room.updatedAt = new Date();
    await room.save();

    res.json({
      message: 'Call ended',
      roomId: room.roomId,
      callDuration: room.callDuration,
      callStartTime: room.callStartTime,
      callEndTime: room.callEndTime
    });
    auditLogger.info(`Call Ended: ${req.params.roomId}`);
  } catch (error) {
    auditLogger.error(`Call End Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.patch('/:roomId/status', async (req, res) => {
  const statusSchema = Joi.object({ status: Joi.string().valid('waiting', 'active', 'ended').required() });
  const { error } = statusSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  try {
    const room = await Room.findOneAndUpdate(
      { roomId: req.params.roomId },
      { 
        status: req.body.status, 
        updatedAt: new Date() 
      },
      { new: true }
    );

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    auditLogger.info(`Room Status Update: ${req.params.roomId} to ${req.body.status}`);
    res.json(room);
  } catch (error) {
    auditLogger.error(`Status Update Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.delete('/:roomId', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    room.participants.forEach(p => {
      if (!p.leftAt) {
        p.leftAt = new Date();
      }
    });

    if (room.status === 'active') {
      room.callEndTime = new Date();
      room.calculateDuration();
    }

    room.status = 'ended';
    room.updatedAt = new Date();
    await room.save();

    auditLogger.info(`Room Soft Deleted: ${req.params.roomId}`);
    res.json({ 
      message: 'Room ended successfully',
      room 
    });
  } catch (error) {
    auditLogger.error(`Room Delete Error: ${error.message}`);
    res.status(500).json({ message: error.message });
  }
});

router.delete('/:roomId/permanent', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.callRecordings && room.callRecordings.length > 0) {
      for (const recording of room.callRecordings) {
        await deleteFromS3(recording.s3Key);
      }
    }

    await Room.findOneAndDelete({ roomId: req.params.roomId });

    auditLogger.info(`Room Hard Deleted: ${req.params.roomId}`);
    res.json({ message: 'Room and all recordings permanently deleted' });
  } catch (error) {
    auditLogger.error(`Room Hard Delete Error: ${error.message}`);
    res.status(500).json({ message: error.message });
  }
});

router.get('/analytics/summary', async (req, res) => {
  try {
    const totalRooms = await Room.countDocuments();
    const activeRooms = await Room.countDocuments({ status: { $in: ['waiting', 'active'] } });
    const endedRooms = await Room.countDocuments({ status: 'ended' });
    
    const avgDuration = await Room.aggregate([
      { $match: { callDuration: { $gt: 0 } } },
      { $group: { _id: null, avgDuration: { $avg: '$callDuration' } } }
    ]);

    const totalChatMessages = await Room.aggregate([
      { $unwind: '$chatMessages' },
      { $group: { _id: null, total: { $sum: 1 } } }
    ]);

    const totalRecordings = await Room.aggregate([
      { $unwind: '$callRecordings' },
      { $group: { _id: null, total: { $sum: 1 } } }
    ]);

    auditLogger.info(`Analytics Access`);
    res.json({
      totalRooms,
      activeRooms,
      endedRooms,
      averageCallDuration: avgDuration[0]?.avgDuration || 0,
      totalChatMessages: totalChatMessages[0]?.total || 0,
      totalRecordings: totalRecordings[0]?.total || 0
    });
  } catch (error) {
    auditLogger.error(`Analytics Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;