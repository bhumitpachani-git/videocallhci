const axios = require('axios');
const winston = require('winston');

const scribeLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: 'logs/medical-scribe.log', 
      maxsize: 5242880, 
      maxFiles: 100 
    }),
    new winston.transports.Console({ format: winston.format.simple() })
  ]
});

const MEDICAL_SCRIBE_CREATE_URL = 'https://22jlxbxhxzlhb2po3qtltrkqlu0afsxw.lambda-url.us-east-2.on.aws/';
const MEDICAL_SCRIBE_STATUS_URL = 'https://yg32eyjbx3p2laumyur32jykhm0mlpoo.lambda-url.us-east-2.on.aws/';

async function createMedicalScribeJob(s3MediaFileUri, jobName) {
  try {
    scribeLogger.info(`Creating Medical Scribe job: ${jobName}`);
    
    const payload = {
      MedicalScribeJobName: jobName,
      Media: {
        MediaFileUri: s3MediaFileUri
      }
    };

    const response = await axios.post(MEDICAL_SCRIBE_CREATE_URL, payload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    scribeLogger.info(`Medical Scribe job created: ${jobName} - Status: ${response.data.MedicalScribeJobStatus}`);
    
    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    scribeLogger.error(`Failed to create Medical Scribe job: ${jobName} - Error: ${error.message}`);
    
    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

async function checkMedicalScribeJobStatus(jobName) {
  try {
    scribeLogger.info(`Checking Medical Scribe job status: ${jobName}`);
    
    const payload = {
      MedicalScribeJobName: jobName
    };

    const response = await axios.post(MEDICAL_SCRIBE_STATUS_URL, payload, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    scribeLogger.info(`Medical Scribe job status: ${jobName} - ${response.data.MedicalScribeJobStatus}`);
    
    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    scribeLogger.error(`Failed to check Medical Scribe job status: ${jobName} - Error: ${error.message}`);
    
    return {
      success: false,
      error: error.response?.data || error.message
    };
  }
}

function generateMedicalScribeJobName(roomId, recordingId) {
  const timestamp = Date.now();
  return `medical-scribe-${roomId}-${recordingId}-${timestamp}`.replace(/[^a-zA-Z0-9-]/g, '-');
}

async function pollMedicalScribeJobStatus(jobName, maxAttempts = 60, intervalMs = 10000) {
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    
    const statusResult = await checkMedicalScribeJobStatus(jobName);
    
    if (!statusResult.success) {
      scribeLogger.error(`Polling failed for job ${jobName} at attempt ${attempts}`);
      throw new Error(`Failed to check job status: ${statusResult.error}`);
    }

    const status = statusResult.data.MedicalScribeJobStatus;
    
    if (status === 'COMPLETED') {
      scribeLogger.info(`Medical Scribe job completed: ${jobName}`);
      return statusResult.data;
    }
    
    if (status === 'FAILED') {
      scribeLogger.error(`Medical Scribe job failed: ${jobName}`);
      throw new Error(`Medical Scribe job failed: ${jobName}`);
    }
    
    scribeLogger.info(`Job ${jobName} still in progress (attempt ${attempts}/${maxAttempts}). Waiting ${intervalMs/1000}s...`);
    
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  throw new Error(`Medical Scribe job timed out after ${maxAttempts} attempts: ${jobName}`);
}

function convertS3UrlToUri(s3Url) {
  const urlPattern = /https:\/\/([^.]+)\.s3\.amazonaws\.com\/(.+)/;
  const match = s3Url.match(urlPattern);
  
  if (match) {
    const bucket = match[1];
    const key = match[2];
    return `s3://${bucket}/${key}`;
  }
  
  if (s3Url.startsWith('s3://')) {
    return s3Url;
  }
  
  throw new Error('Invalid S3 URL format');
}

module.exports = {
  createMedicalScribeJob,
  checkMedicalScribeJobStatus,
  generateMedicalScribeJobName,
  pollMedicalScribeJobStatus,
  convertS3UrlToUri,
  scribeLogger
};
