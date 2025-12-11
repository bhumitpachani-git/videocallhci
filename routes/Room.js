const express = require('express');
const router = express.Router();
const Room = require('../models/Room');

// Get all rooms with pagination and filters
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
    res.status(500).json({ message: error.message });
  }
});

// Get room by roomId
router.get('/:roomId', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }
    res.json(room);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get room statistics
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

    res.json(stats);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get chat history for a room
router.get('/:roomId/chat', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    res.json({
      roomId: room.roomId,
      chatMessages: room.chatMessages,
      totalMessages: room.chatMessages.length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get rooms by creator
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
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get active rooms
router.get('/status/active', async (req, res) => {
  try {
    const activeRooms = await Room.find({ 
      status: { $in: ['waiting', 'active'] } 
    }).sort({ createdAt: -1 });

    res.json({
      activeRooms,
      count: activeRooms.length
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new room
router.post('/', async (req, res) => {
  try {
    const { roomId, creator } = req.body;

    // Check if room already exists
    const existingRoom = await Room.findOne({ roomId });
    if (existingRoom) {
      return res.status(400).json({ message: 'Room already exists' });
    }

    const room = new Room({
      roomId,
      creator: {
        participantId: creator.participantId,
        participantName: creator.participantName,
        role: creator.role || 'admin'
      },
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
    res.status(201).json(newRoom);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Add participant to room
router.post('/:roomId/participants', async (req, res) => {
  try {
    const { participantId, participantName, role } = req.body;
    
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (room.participants.length >= room.metadata.maxParticipants) {
      return res.status(400).json({ message: 'Room is full' });
    }

    room.addParticipant(participantId, participantName, role);
    
    // Start call if this is the second participant
    if (room.participants.length === 2 && !room.callStartTime) {
      room.callStartTime = new Date();
      room.status = 'active';
    }

    room.updatedAt = new Date();
    await room.save();

    res.json(room);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Remove participant from room
router.delete('/:roomId/participants/:participantId', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    room.removeParticipant(req.params.participantId);
    
    const activeParticipants = room.participants.filter(p => !p.leftAt);
    
    // End call if no active participants left
    if (activeParticipants.length === 0 && room.status === 'active') {
      room.callEndTime = new Date();
      room.calculateDuration();
      room.status = 'ended';
    }

    room.updatedAt = new Date();
    await room.save();

    res.json(room);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Add chat message to room
router.post('/:roomId/chat', async (req, res) => {
  try {
    const { senderId, senderName, message } = req.body;
    
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    room.addChatMessage(senderId, senderName, message);
    room.updatedAt = new Date();
    await room.save();

    res.json({
      message: 'Chat message added',
      chatMessage: room.chatMessages[room.chatMessages.length - 1]
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Start call (when both participants are ready)
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

    res.json(room);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// End call
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
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update room status
router.patch('/:roomId/status', async (req, res) => {
  try {
    const { status } = req.body;
    
    const room = await Room.findOneAndUpdate(
      { roomId: req.params.roomId },
      { 
        status, 
        updatedAt: new Date() 
      },
      { new: true }
    );

    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    res.json(room);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete room (soft delete - mark as ended)
router.delete('/:roomId', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Mark all participants as left
    room.participants.forEach(p => {
      if (!p.leftAt) {
        p.leftAt = new Date();
      }
    });

    // End call if active
    if (room.status === 'active') {
      room.callEndTime = new Date();
      room.calculateDuration();
    }

    room.status = 'ended';
    room.updatedAt = new Date();
    await room.save();

    res.json({ 
      message: 'Room ended successfully',
      room 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Hard delete room (permanently remove)
router.delete('/:roomId/permanent', async (req, res) => {
  try {
    const room = await Room.findOneAndDelete({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }
    res.json({ message: 'Room permanently deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get room analytics
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
      { $project: { messageCount: { $size: '$chatMessages' } } },
      { $group: { _id: null, total: { $sum: '$messageCount' } } }
    ]);

    res.json({
      totalRooms,
      activeRooms,
      endedRooms,
      averageCallDuration: avgDuration[0]?.avgDuration || 0,
      totalChatMessages: totalChatMessages[0]?.total || 0
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;