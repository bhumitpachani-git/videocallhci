const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    if (process.env.NODE_ENV === 'production') {
      mongoose.set('debug', false);
    }
    const conn = await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/hci-video');
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;