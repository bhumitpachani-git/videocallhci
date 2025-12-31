const express = require('express');
const router = express.Router();
const Joi = require('joi');
const Room = require('../models/Room');
const {
  createMedicalScribeJob,
  checkMedicalScribeJobStatus,
  generateMedicalScribeJobName,
  pollMedicalScribeJobStatus,
  convertS3UrlToUri,
  scribeLogger
} = require('../services/medicalScribeService');


router.post('/:roomId/call-recordings/:recordingId/transcribe', async (req, res) => {
  try {
    const { roomId, recordingId } = req.params;
    const { autoCheckStatus = false } = req.body;

    const room = await Room.findOne({ roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const recording = room.callRecordings.id(recordingId);
    if (!recording) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    if (recording.MedicalScribeJobName && recording.MedicaltxtURL) {
      return res.status(400).json({
        message: 'Transcription already completed for this recording',
        jobName: recording.MedicalScribeJobName,
        transcriptUrl: recording.MedicaltxtURL
      });
    }

    if (recording.MedicalScribeJobName) {
      const statusResult = await checkMedicalScribeJobStatus(recording.MedicalScribeJobName);
      
      if (statusResult.success && statusResult.data.MedicalScribeJobStatus === 'IN_PROGRESS') {
        return res.status(400).json({
          message: 'Transcription already in progress',
          jobName: recording.MedicalScribeJobName,
          status: statusResult.data.MedicalScribeJobStatus
        });
      }
    }

    const s3Uri = convertS3UrlToUri(recording.s3Url);

    const jobName = generateMedicalScribeJobName(roomId, recordingId);

    const createResult = await createMedicalScribeJob(s3Uri, jobName);

    if (!createResult.success) {
      scribeLogger.error(`Failed to create transcription job for ${roomId}/${recordingId}: ${createResult.error}`);
      return res.status(500).json({
        message: 'Failed to start transcription',
        error: createResult.error
      });
    }

    recording.MedicalScribeJobName = jobName;
    await room.save();

    scribeLogger.info(`Transcription started for ${roomId}/${recordingId}: ${jobName}`);

    const response = {
      message: 'Medical Scribe transcription started successfully',
      roomId,
      recordingId,
      jobName: createResult.data.MedicalScribeJobName,
      status: createResult.data.MedicalScribeJobStatus,
      s3Uri
    };

    if (autoCheckStatus) {
      const statusResult = await checkMedicalScribeJobStatus(jobName);
      if (statusResult.success) {
        response.currentStatus = statusResult.data;
      }
    }

    res.json(response);
  } catch (error) {
    scribeLogger.error(`Transcribe endpoint error: ${error.message}`);
    res.status(500).json({ 
      message: 'Server error',
      error: error.message 
    });
  }
});

router.get('/:roomId/call-recordings/:recordingId/transcribe/status', async (req, res) => {
  try {
    const { roomId, recordingId } = req.params;

    const room = await Room.findOne({ roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const recording = room.callRecordings.id(recordingId);
    if (!recording) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    if (!recording.MedicalScribeJobName) {
      return res.status(404).json({
        message: 'No transcription job found for this recording',
        recordingId
      });
    }

    const statusResult = await checkMedicalScribeJobStatus(recording.MedicalScribeJobName);

    if (!statusResult.success) {
      return res.status(500).json({
        message: 'Failed to check transcription status',
        error: statusResult.error
      });
    }

    if (statusResult.data.MedicalScribeJobStatus === 'COMPLETED' && 
        statusResult.data.MedicaltxtURL && 
        !recording.MedicaltxtURL) {
      
      recording.MedicaltxtURL = statusResult.data.MedicaltxtURL;
      await room.save();
      
      scribeLogger.info(`Transcript URL saved for ${roomId}/${recordingId}: ${statusResult.data.MedicaltxtURL}`);
    }

    res.json({
      roomId,
      recordingId,
      jobName: recording.MedicalScribeJobName,
      status: statusResult.data.MedicalScribeJobStatus,
      transcriptUrl: statusResult.data.MedicaltxtURL || recording.MedicaltxtURL,
      fileName: recording.fileName,
      uploadedAt: recording.uploadedAt
    });
  } catch (error) {
    scribeLogger.error(`Status check error: ${error.message}`);
    res.status(500).json({ 
      message: 'Server error',
      error: error.message 
    });
  }
});

router.post('/:roomId/call-recordings/:recordingId/transcribe/poll', async (req, res) => {
  try {
    const { roomId, recordingId } = req.params;
    const { maxAttempts = 60, intervalSeconds = 10 } = req.body;

    const room = await Room.findOne({ roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }
    const recording = room.callRecordings.id(recordingId);
    if (!recording) {
      return res.status(404).json({ message: 'Recording not found' });
    }
    if (!recording.MedicalScribeJobName) {
      return res.status(404).json({
        message: 'No transcription job found for this recording. Please start transcription first.',
        recordingId
      });
    }

    scribeLogger.info(`Starting polling for job: ${recording.MedicalScribeJobName}`);
    const finalStatus = await pollMedicalScribeJobStatus(
      recording.MedicalScribeJobName,
      maxAttempts,
      intervalSeconds * 1000
    );

    if (finalStatus.MedicaltxtURL) {
      recording.MedicaltxtURL = finalStatus.MedicaltxtURL;
      await room.save();
      
      scribeLogger.info(`Polling complete. Transcript saved for ${roomId}/${recordingId}`);
    }

    res.json({
      message: 'Transcription completed successfully',
      roomId,
      recordingId,
      jobName: recording.MedicalScribeJobName,
      status: finalStatus.MedicalScribeJobStatus,
      transcriptUrl: finalStatus.MedicaltxtURL,
      pollingAttempts: maxAttempts,
      pollingInterval: intervalSeconds
    });
  } catch (error) {
    scribeLogger.error(`Polling error: ${error.message}`);
    res.status(500).json({ 
      message: 'Polling failed',
      error: error.message 
    });
  }
});

router.get('/:roomId/call-recordings/:recordingId/transcript', async (req, res) => {
  try {
    const { roomId, recordingId } = req.params;

    const room = await Room.findOne({ roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const recording = room.callRecordings.id(recordingId);
    if (!recording) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    if (!recording.MedicaltxtURL) {
      if (recording.MedicalScribeJobName) {
        const statusResult = await checkMedicalScribeJobStatus(recording.MedicalScribeJobName);
        
        if (statusResult.success && 
            statusResult.data.MedicalScribeJobStatus === 'COMPLETED' && 
            statusResult.data.MedicaltxtURL) {
          
          recording.MedicaltxtURL = statusResult.data.MedicaltxtURL;
          await room.save();
          
          return res.json({
            roomId,
            recordingId,
            transcriptUrl: statusResult.data.MedicaltxtURL,
            jobName: recording.MedicalScribeJobName,
            status: 'COMPLETED'
          });
        }
      }

      return res.status(404).json({
        message: 'Transcript not available yet',
        recordingId,
        jobName: recording.MedicalScribeJobName || null,
        hint: recording.MedicalScribeJobName 
          ? 'Transcription may still be in progress. Check status endpoint.' 
          : 'No transcription job started for this recording.'
      });
    }

    res.json({
      roomId,
      recordingId,
      transcriptUrl: recording.MedicaltxtURL,
      jobName: recording.MedicalScribeJobName,
      fileName: recording.fileName,
      uploadedAt: recording.uploadedAt
    });
  } catch (error) {
    scribeLogger.error(`Transcript retrieval error: ${error.message}`);
    res.status(500).json({ 
      message: 'Server error',
      error: error.message 
    });
  }
});

router.get('/:roomId/transcriptions', async (req, res) => {
  try {
    const { roomId } = req.params;

    const room = await Room.findOne({ roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const transcriptions = room.callRecordings.map(recording => ({
      recordingId: recording._id,
      fileName: recording.fileName,
      uploadedAt: recording.uploadedAt,
      jobName: recording.MedicalScribeJobName || null,
      transcriptUrl: recording.MedicaltxtURL || null,
      hasTranscription: !!recording.MedicaltxtURL,
      transcriptionInProgress: !!recording.MedicalScribeJobName && !recording.MedicaltxtURL
    }));

    const summary = {
      totalRecordings: transcriptions.length,
      withTranscripts: transcriptions.filter(t => t.hasTranscription).length,
      inProgress: transcriptions.filter(t => t.transcriptionInProgress).length,
      noTranscription: transcriptions.filter(t => !t.jobName).length
    };

    res.json({
      roomId,
      summary,
      transcriptions
    });
  } catch (error) {
    scribeLogger.error(`Get transcriptions error: ${error.message}`);
    res.status(500).json({ 
      message: 'Server error',
      error: error.message 
    });
  }
});

router.delete('/:roomId/call-recordings/:recordingId/transcription', async (req, res) => {
  try {
    const { roomId, recordingId } = req.params;

    const room = await Room.findOne({ roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const recording = room.callRecordings.id(recordingId);
    if (!recording) {
      return res.status(404).json({ message: 'Recording not found' });
    }

    const oldJobName = recording.MedicalScribeJobName;
    const oldTranscriptUrl = recording.MedicaltxtURL;

    recording.MedicalScribeJobName = null;
    recording.MedicaltxtURL = null;
    await room.save();

    scribeLogger.info(`Transcription data cleared for ${roomId}/${recordingId}`);

    res.json({
      message: 'Transcription data cleared successfully',
      roomId,
      recordingId,
      clearedJobName: oldJobName,
      clearedTranscriptUrl: oldTranscriptUrl
    });
  } catch (error) {
    scribeLogger.error(`Clear transcription error: ${error.message}`);
    res.status(500).json({ 
      message: 'Server error',
      error: error.message 
    });
  }
});

module.exports = router;