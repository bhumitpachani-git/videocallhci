const express = require('express');
const router = express.Router();
const CallHistory = require('../models/CallHistory');

// Get all call history
router.get('/', async (req, res) => {
  try {
    const history = await CallHistory.find().sort({ date: -1 });
    res.json(history);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get call record by _id
router.get('/:id', async (req, res) => {
  try {
    const call = await CallHistory.findById(req.params.id);
    if (!call) {
      return res.status(404).json({ message: 'Call record not found' });
    }
    res.json(call);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get call history by device (caller or receiver)
router.get('/device/:deviceId', async (req, res) => {
  try {
    const history = await CallHistory.find({
      $or: [
        { callerId: req.params.deviceId },
        { receiverId: req.params.deviceId }
      ]
    }).sort({ date: -1 });
    res.json(history);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new call record
router.post('/', async (req, res) => {
  const call = new CallHistory({
    callerId: req.body.callerId,
    callerName: req.body.callerName,
    receiverId: req.body.receiverId,
    receiverName: req.body.receiverName,
    startTime: req.body.startTime,
    endTime: req.body.endTime,
    duration: req.body.duration,
    status: req.body.status,
    date: req.body.date || Date.now()
  });

  try {
    const newCall = await call.save();
    res.status(201).json(newCall);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update call record by _id
router.put('/:id', async (req, res) => {
  try {
    const call = await CallHistory.findByIdAndUpdate(
      req.params.id,
      {
        endTime: req.body.endTime,
        duration: req.body.duration,
        status: req.body.status
      },
      { new: true }
    );
    if (!call) {
      return res.status(404).json({ message: 'Call record not found' });
    }
    res.json(call);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete call record by _id
router.delete('/:id', async (req, res) => {
  try {
    const call = await CallHistory.findByIdAndDelete(req.params.id);
    if (!call) {
      return res.status(404).json({ message: 'Call record not found' });
    }
    res.json({ message: 'Call record deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;