'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const fileDuration = require('../helpers/file-duration');
const settings = require('../../settings');
const logger = require('sonos-discovery/lib/helpers/logger');

const DEFAULT_SETTINGS = {
  OutputFormat: 'mp3',
  VoiceId: 'Joanna',
  TextType: 'text',
  Engine: 'neural'
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
  if (voiceName) {
    synthesizeParameters.VoiceId = voiceName;
  }
  if (phrase.startsWith('<speak>') && phrase.endsWith('</speak>')) {
    synthesizeParameters.TextType = 'ssml';
  }
  
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

  function saveStream(fromStream, filename) {
    return new Promise((resolve, reject) => {
      let toStream = fs.createWriteStream(filename);
      toStream.on('finish', resolve);
      toStream.on('error', reject);
      fromStream.pipe(toStream);
    })
  }

  const constructorParameters = {
    region: (settings.aws.credentials && settings.aws.credentials.region) || 'us-east-1'
  };

  if (settings.aws.credentials && settings.aws.credentials.accessKeyId && settings.aws.credentials.secretAccessKey) {
    constructorParameters.credentials = {
      accessKeyId: settings.aws.credentials.accessKeyId,
      secretAccessKey: settings.aws.credentials.secretAccessKey
    };
  }

  const polly = new PollyClient(constructorParameters);
  
  return polly
    .send(new SynthesizeSpeechCommand(synthesizeParameters))
    .then((data) => {
      if (!data || !data.AudioStream) throw Error(`bad response`);
      return saveStream(data.AudioStream, filepath);
    })
    .then(() => {
      return fileDuration(filepath);
    })
    .then((duration) => {
      return {
        duration,
        uri: expectedUri
      };
    })
    .catch((error) => {
      console.error(error);
    });
}

module.exports = polly;
