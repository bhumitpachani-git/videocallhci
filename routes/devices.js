const express = require('express');
const router = express.Router();
const Joi = require('joi');
const Device = require('../models/Device');
const winston = require('winston');

const auditLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
});

const deviceSchema = Joi.object({
  floor: Joi.string().max(50).required(),
  room: Joi.string().max(50).required(),
  deviceName: Joi.string().min(1).max(100).required(),
  deviceId: Joi.string().alphanum().max(50).required()
});

router.get('/', async (req, res) => {
  try {
    const devices = await Device.find().sort({ createdAt: -1 });
    auditLogger.info(`Devices List Access`);
    res.json(devices);
  } catch (error) {
    auditLogger.error(`Devices List Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const device = await Device.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    auditLogger.info(`Device View: ${req.params.id}`);
    res.json(device);
  } catch (error) {
    auditLogger.error(`Device View Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/by-device-id/:deviceId', async (req, res) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    auditLogger.info(`Device View by ID: ${req.params.deviceId}`);
    res.json(device);
  } catch (error) {
    auditLogger.error(`Device View by ID Error: ${error.message}`);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  const { error } = deviceSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  const device = new Device({
    ...req.body,
    status: 'offline'
  });

  try {
    const newDevice = await device.save();
    auditLogger.info(`Device Created: ${req.body.deviceId}`);
    res.status(201).json(newDevice);
  } catch (error) {
    auditLogger.error(`Device Create Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.put('/:id', async (req, res) => {
  const { error } = deviceSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  try {
    const device = await Device.findByIdAndUpdate(
      req.params.id,
      { 
        ...req.body,
        updatedAt: Date.now() 
      },
      { new: true }
    );
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    auditLogger.info(`Device Updated: ${req.params.id}`);
    res.json(device);
  } catch (error) {
    auditLogger.error(`Device Update Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.patch('/:id/status', async (req, res) => {
  const statusSchema = Joi.object({ status: Joi.string().valid('online', 'offline', 'busy').required() });
  const { error } = statusSchema.validate(req.body);
  if (error) return res.status(400).json({ message: error.details[0].message });

  try {
    const device = await Device.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status, updatedAt: Date.now() },
      { new: true }
    );
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    auditLogger.info(`Device Status Update: ${req.params.id} to ${req.body.status}`);
    res.json(device);
  } catch (error) {
    auditLogger.error(`Device Status Error: ${error.message}`);
    res.status(400).json({ message: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const device = await Device.findByIdAndDelete(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    auditLogger.info(`Device Deleted: ${req.params.id}`);
    res.json({ message: 'Device deleted successfully' });
  } catch (error) {
    auditLogger.error(`Device Delete Error: ${error.message}`);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;