const express = require('express');
const router = express.Router();
const Joi = require('joi');
const CallHistory = require('../models/CallHistory');
const winston = require('winston');

const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

const callSchema = Joi.object({
  callerId: Joi.string().required(),
  callerName: Joi.string().min(1).max(100).required(),
  receiverId: Joi.string().required(),
  receiverName: Joi.string().min(1).max(100).required(),
  startTime: Joi.date().required(),
  endTime: Joi.date(),
  duration: Joi.number().min(0),
  status: Joi.string().valid('completed', 'missed', 'rejected', 'busy').required(),
  date: Joi.date()
});

router.get('/', async (req, res) => {
  try {
    const history = await CallHistory.find().sort({ date: -1 });
    auditLogger.info(`Call History List Access`);
    res.json(history);
  } catch (error) {
    auditLogger.error(`Call History List Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const call = await CallHistory.findById(req.params.id);
    if (!call) {
      return res.status(404).json({ message: 'Call record not found' });
    }
    auditLogger.info(`Call View: ${req.params.id}`);
    res.json(call);
  } catch (error) {
    auditLogger.error(`Call View Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/device/:deviceId', async (req, res) => {
  try {
    const history = await CallHistory.find({
      $or: [
        { callerId: req.params.deviceId },
        { receiverId: req.params.deviceId }
      ]
    }).sort({ date: -1 });
    auditLogger.info(`Call History by Device: ${req.params.deviceId}`);
    res.json(history);
  } catch (error) {
    auditLogger.error(`Call History by Device Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  const { error } = callSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  const call = new CallHistory({
    ...req.body,
    date: req.body.date || Date.now()
  });

  try {
    const newCall = await call.save();
    auditLogger.info(`Call Record Created: ${req.body.callerId} to ${req.body.receiverId}`);
    res.status(201).json(newCall);
  } catch (error) {
    auditLogger.error(`Call Create Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  const updateSchema = Joi.object({
    endTime: Joi.date(),
    duration: Joi.number().min(0),
    status: Joi.string().valid('completed', 'missed', 'rejected', 'busy')
  });
  const { error } = updateSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

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
    auditLogger.info(`Call Updated: ${req.params.id}`);
    res.json(call);
  } catch (error) {
    auditLogger.error(`Call Update Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const call = await CallHistory.findByIdAndDelete(req.params.id);
    if (!call) {
      return res.status(404).json({ message: 'Call record not found' });
    }
    auditLogger.info(`Call Deleted: ${req.params.id}`);
    res.json({ message: 'Call record deleted successfully' });
  } catch (error) {
    auditLogger.error(`Call Delete Error: ${error.message}`);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;