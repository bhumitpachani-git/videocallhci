const express = require('express');
const router = express.Router();
const Device = require('../models/Device');

// Get all devices
router.get('/', async (req, res) => {
  try {
    const devices = await Device.find().sort({ createdAt: -1 });
    res.json(devices);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get device by MongoDB _id
router.get('/:id', async (req, res) => {
  try {
    const device = await Device.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    res.json(device);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get device by deviceId (custom field)
router.get('/by-device-id/:deviceId', async (req, res) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId });
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    res.json(device);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create new device
router.post('/', async (req, res) => {
  const device = new Device({
    floor: req.body.floor,
    room: req.body.room,
    deviceName: req.body.deviceName,
    deviceId: req.body.deviceId,
    status: 'offline'
  });

  try {
    const newDevice = await device.save();
    res.status(201).json(newDevice);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update device by _id
router.put('/:id', async (req, res) => {
  try {
    const device = await Device.findByIdAndUpdate(
      req.params.id,
      { 
        floor: req.body.floor,
        room: req.body.room,
        deviceName: req.body.deviceName,
        deviceId: req.body.deviceId,
        updatedAt: Date.now() 
      },
      { new: true }
    );
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    res.json(device);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update device status only
router.patch('/:id/status', async (req, res) => {
  try {
    const device = await Device.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status, updatedAt: Date.now() },
      { new: true }
    );
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    res.json(device);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete device by _id
router.delete('/:id', async (req, res) => {
  try {
    const device = await Device.findByIdAndDelete(req.params.id);
    if (!device) {
      return res.status(404).json({ message: 'Device not found' });
    }
    res.json({ message: 'Device deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;