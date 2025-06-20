'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const AWS = require('aws-sdk');
const fileDuration = require('../helpers/file-duration');
const voiceInfo = require('../helpers/get-voice-id');
const settings = require('../../settings');
const logger = require('sonos-discovery/lib/helpers/logger');

const DEFAULT_SETTINGS = {
  OutputFormat: 'mp3',
  VoiceId: 'Joanna',
  TextType: 'text'
};

function polly(phrase, voiceName) {
  if (!settings.aws) {
    return Promise.resolve();

  }

  // Construct a filesystem neutral filename
  const dynamicParameters = { Text: phrase };
  const synthesizeParameters = Object.assign({}, DEFAULT_SETTINGS, dynamicParameters);
  if (settings.aws.name) {
    synthesizeParameters.VoiceId = settings.aws.name;
  }
  if (voiceInfo.getVoiceName(voiceName)) {
    synthesizeParameters.VoiceId = voiceInfo.getVoiceName(voiceName);
  }
  if (voiceInfo.getVoiceEngine(voiceName)){
    synthesizeParameters.Engine = voiceInfo.getVoiceEngine(voiceName).toLowerCase();
  } else {
    synthesizeParameters.Engine = 'neural';
  }
  // if (synthesizeParameters.VoiceId.endsWith('Neural')) {
  //   synthesizeParameters.Engine = 'neural';
  //   synthesizeParameters.VoiceId = synthesizeParameters.VoiceId.slice(0, -6);
  // }
  // if (synthesizeParameters.VoiceId.endsWith('Generative')) {
  //   synthesizeParameters.Engine = 'generative';
  //   synthesizeParameters.VoiceId = synthesizeParameters.VoiceId.slice(0, -10);
  // }
  // if (phrase.startsWith('<speak>') && phrase.endsWith('</speak>')) {
  //   synthesizeParameters.TextType = 'ssml';
  //   synthesizeParameters.Engine = 'neural';
  // }

  const phraseHash = crypto.createHash('sha1').update(phrase).digest('hex');
  const filename = `polly-${phraseHash}-${synthesizeParameters.VoiceId}-${synthesizeParameters.Engine}.mp3`;
  const filepath = path.resolve(settings.webroot, 'tts', filename);

  const expectedUri = `/tts/${filename}`;
  try {
    fs.accessSync(filepath, fs.R_OK);
    return fileDuration(filepath)
      .then((duration) => {
        return {
          duration,
          uri: expectedUri
        };
      });
  } catch (err) {
    logger.info(`announce file for phrase "${phrase}" does not seem to exist, downloading`);
  }

  const constructorParameters = Object.assign({ apiVersion: '2016-06-10' }, settings.aws.credentials);

  const polly = new AWS.Polly(constructorParameters);

  return polly.synthesizeSpeech(synthesizeParameters)
    .promise()
    .then((data) => {
      fs.writeFileSync(filepath, data.AudioStream);
      return fileDuration(filepath);
    })
    .then((duration) => {
      return {
        duration,
        uri: expectedUri
      };
    });
}

module.exports = polly;