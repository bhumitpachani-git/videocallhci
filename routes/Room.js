const express = require('express');
const router = express.Router();
const Joi = require('joi');
const Room = require('../models/Room');
const winston = require('winston');
const CryptoJS = require('crypto-js');

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
      createdAt: room.createdAt,
      callStartTime: room.callStartTime,
      callEndTime: room.callEndTime
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

    // Show all chat messages in the room
    let messages = room.chatMessages || [];

    // Decrypt messages before sending
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
// Create new room
router.post('/', async (req, res) => {
  const { error } = roomSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  try {
    const { roomId, creator } = req.body;
    creator.participantName = creator.participantName.trim() || 'Anonymous'; // HIPAA: Non-empty plain

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

    const newRoom = await room.save(); // Encrypts in pre-save
    auditLogger.info(`Room Created: ${roomId}`);
    res.status(201).json(newRoom); // Decrypted in post-find
  } catch (error) {
    auditLogger.error(`Room Create Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

// Add participant to room
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

    // Plain to model
    room.addParticipant(req.body.participantId, req.body.participantName.trim() || 'Anonymous', req.body.role);
    
    if (room.participants.length === 2 && !room.callStartTime) {
      room.callStartTime = new Date();
      room.status = 'active';
    }

    room.updatedAt = new Date();
    await room.save();
    auditLogger.info(`Participant Added: ${req.body.participantId} to ${req.params.roomId}`);

    res.json(room); // Decrypted
  } catch (error) {
    auditLogger.error(`Participant Add Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

// Add chat message to room
router.post('/:roomId/chat', async (req, res) => {
  const chatSchema = Joi.object({
    senderId: Joi.string().required(),
    senderName: Joi.string().min(1).max(100).required(), // Non-empty plain
    message: Joi.string().min(1).max(1000).required() // Non-empty plain
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

    // Clear all chat messages in this room when call is explicitly ended
    // room.chatMessages = [];

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
    const room = await Room.findOneAndDelete({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }
    auditLogger.info(`Room Hard Deleted: ${req.params.roomId}`);
    res.json({ message: 'Room permanently deleted' });
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

    auditLogger.info(`Analytics Access`);
    res.json({
      totalRooms,
      activeRooms,
      endedRooms,
      averageCallDuration: avgDuration[0]?.avgDuration || 0,
      totalChatMessages: totalChatMessages[0]?.total || 0
    });
  } catch (error) {
    auditLogger.error(`Analytics Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;