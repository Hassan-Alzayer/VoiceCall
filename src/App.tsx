/**
 * App.tsx  (React + TypeScript, Vite)
 * ===================================
 * A **Daily.co**-powered audio-only calling UI with built-in microphone/speaker
 * tests **and** a live anti-scam pipeline that streams raw audio to a
 * Whisper-GPT-SVM backend (see `scamSocket.ts`).
 *
 *  - Create private rooms on the fly (`/rooms` Daily REST API).
 *  - Join / leave existing rooms.
 *  - Realtime mic-level + speaker playback diagnostics.
 *  - Force-subscribe to every remote participant’s audio track.
 *  - Streams **all** incoming / outgoing audio to the `/ws/audio` endpoint
 *    for scam detection; hangs up automatically on detection.
 *

/* ────────────────────────────────────────────────────────────────────────── */

import React, { useState, useEffect, useRef } from 'react';
import Daily from '@daily-co/daily-js';
import { Phone, PhoneOff, Mic, MicOff, Users, Copy, Check, Mail, MessageCircle } from 'lucide-react';
import { openScamWs, ScoreMsg, ScamMsg } from "./scamSocket";
/* ─── Types ──────────────────────────────────────────────────────────────── */
/** Finite state-machine for the call lifecycle */
type CallState = 'idle' | 'creating' | 'joining' | 'joined' | 'leaving' | 'error';

const DAILY_API_KEY = import.meta.env.VITE_DAILY_API_KEY || '62a4c2e754bc168c3a6130276d7dd0b1e95c8efb48a1fcc2e4eeadc25c362ee2';
const DAILY_API_BASE_URL = import.meta.env.VITE_DAILY_API_BASE_URL || 'https://api.daily.co/v1';
/** UI-friendly representation of the current call status */
interface CallStatus {
  state: CallState;
  message: string;
  participantCount?: number;
}
/** Object returned by Daily REST API when a room is created */
interface RoomInfo {
  url: string;
  name: string;
}
/** Local audio test state (mic & speakers) */
interface AudioTestState {
  isTestingMic: boolean;
  isTestingAudio: boolean;
  micLevel: number;
  testPassed: boolean;
  speakerTestResult: 'none' | 'playing' | 'success' | 'failed';
  speakerVolume: number;
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN REACT COMPONENT
   ══════════════════════════════════════════════════════════════════════════ */
function App() {
    /* ─── React state & refs ──────────────────────────────────────────────── */
  const [contactName, setContactName] = useState('');
  const [roomUrl, setRoomUrl] = useState('');
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>({ 
    state: 'idle', 
    message: 'Not connected' 
  });
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /* ── Available / selected I/O devices ────────────────────────────────── */
  const [availableDevices, setAvailableDevices] = useState<{
    microphones: MediaDeviceInfo[];
    speakers: MediaDeviceInfo[];
  }>({ microphones: [], speakers: [] });
  const [selectedDevices, setSelectedDevices] = useState<{
    microphone: string;
    speaker: string;
  }>({ microphone: 'default', speaker: 'default' });
  /* ── Local audio-test state ──────────────────────────────────────────── */
  const [audioTest, setAudioTest] = useState<AudioTestState>({
    isTestingMic: false,
    isTestingAudio: false,
    micLevel: 0,
    testPassed: false,
    speakerTestResult: 'none',
    speakerVolume: 50
  });
  const [microphoneBoost, setMicrophoneBoost] = useState(80);
   /* ── Persistent/non-reactive handles ─────────────────────────────────── */
  const callObjectRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
   // WebSocket to the anti-scam backend
  const scamSocketRef = useRef<ReturnType<typeof openScamWs> | null>(null);
  // MediaRecorder used by scam-guard when we get remote tracks
  const recorderRef   = useRef<MediaRecorder | null>(null);

   /* ─── Lifecycle: componentDidMount / unmount ─────────────────────────── */
  useEffect(() => {
    // Load available audio devices
    loadAudioDevices();
    
    // Cleanup on unmount
    return () => {
      if (callObjectRef.current) {
        callObjectRef.current.destroy();
      }
      stopAudioTest();

      if (recorderRef.current) {
        recorderRef.current.stop();
        recorderRef.current = null;
      }
      if (scamSocketRef.current) {
        scamSocketRef.current.disconnect();
        scamSocketRef.current = null;
      }
    };
  }, []);

  /* ══════════════════════════════════════════════════════════════════════
     Audio helpers
     ══════════════════════════════════════════════════════════════════════ */

   /**
   * Down-sample a **Float32** buffer from `sampleRate` → `outRate` (16 kHz
   * by default). Whisper’s backend expects 16-kHz, 16-bit PCM.
   *
   * @param buffer      Input Float32Array
   * @param sampleRate  Current sampling rate (Hz)
   * @param outRate     Target rate, default = 16000 Hz
   * @returns           Resampled Float32Array
   */

    
  // ── downsampleBuffer ───────────────────────────────────────
// take a Float32Array @ sampleRate and resample it to outRate (16 kHz)
  function downsampleBuffer(
    buffer: Float32Array,
    sampleRate: number,
    outRate = 16000
  ): Float32Array {
    if (outRate === sampleRate) return buffer;
    const ratio = sampleRate / outRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < newLength) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let sum = 0, count = 0;
      for (
        let i = offsetBuffer;
        i < nextOffsetBuffer && i < buffer.length;
        i++
      ) {
        sum += buffer[i];
        count++;
      }
      result[offsetResult] = sum / count;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  

  /**
   * Start recording audio from the given MediaStream and send it to the
   * WebSocket at /ws/audio as a series of base64-encoded 16-bit PCM
   * chunks, with the timestamp of each chunk in seconds as "ts".
   *
   * The audio is downsampled from the input rate to 16 kHz before
   * transmission.
   *
   * The WebSocket connection is expected to be open before calling this
   * function; if it is not open, the function does nothing.
   *
   * @param stream  MediaStream to record from
   * @param ws      WebSocket connection to send data to
   */
  function startRecorder(stream: MediaStream, ws: WebSocket) {
  // 1) build Web Audio graph
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const audioContext = new AudioCtx();
  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  source.connect(processor);
  processor.connect(audioContext.destination);

  // 2) on each audio callback, downsample → Int16 → base64 → send
  processor.onaudioprocess = (event) => {
    // raw float32 PCM [-1…1]
    const floatData = event.inputBuffer.getChannelData(0);
    // down to 16 kHz
    const down = downsampleBuffer(
      floatData,
      audioContext.sampleRate,
      16000
    );
    // convert to 16‑bit signed
    const int16 = new Int16Array(down.length);
    for (let i = 0; i < down.length; i++) {
      const s = Math.max(-1, Math.min(1, down[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // bytes → base64
    const bytes = new Uint8Array(int16.buffer);
    const b64 = btoa(String.fromCharCode(...bytes));
    if (ws.readyState === WebSocket.OPEN) {
  ws.send(JSON.stringify({ payload: b64, ts: Date.now()/1000 }));
    }

  };
}


  /**
   * Load audio devices and set default devices if none are selected
   * 
   * 1. Request audio permissions
   * 2. Enumerate audio devices
   * 3. Filter for microphones and speakers
   * 4. Set available devices
   * 5. Set default devices if none selected
   * 6. Catch and log any errors
   */
  const loadAudioDevices = async () => {
    try {
      // Request permissions first
      await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      
      const devices = await navigator.mediaDevices.enumerateDevices();
      const microphones = devices.filter(device => device.kind === 'audioinput');
      const speakers = devices.filter(device => device.kind === 'audiooutput');
      
      setAvailableDevices({ microphones, speakers });
      
      // Set default devices if none selected
      if (selectedDevices.microphone === 'default' && microphones.length > 0) {
        setSelectedDevices(prev => ({ ...prev, microphone: microphones[0].deviceId }));
      }
      if (selectedDevices.speaker === 'default' && speakers.length > 0) {
        setSelectedDevices(prev => ({ ...prev, speaker: speakers[0].deviceId }));
      }
    } catch (err) {
      console.error('Failed to load audio devices:', err);
    }
  };

  /**
   * Generate a unique room name based on the contact's name and the current time
   * @param {string} contactName - The name of the contact to generate a room name for
   * @returns {string} - A unique room name in the format "call-<contact-name>-<random-id>-<timestamp>"
   */
  const generateRoomName = (contactName: string): string => {
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);
    return `call-${contactName.toLowerCase().replace(/[^a-z0-9]/g, '')}-${randomId}-${timestamp}`;
  };


  /**
   * Create a new Daily room via the REST API.
   *
   * @param contactName  Friendly name used in the UI.
   * @returns            Full `https://…daily.co/<room>` URL
   */
  const createRoom = async (contactName: string): Promise<string> => {
    try {
      setCallStatus({ state: 'creating', message: 'Creating room...' });
      
      const roomName = generateRoomName(contactName);
      
      // Create room using Daily API
      const response = await fetch(`${DAILY_API_BASE_URL}/rooms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DAILY_API_KEY}`,
        },
        body: JSON.stringify({
          name: roomName,
          properties: {
            enable_chat: false,
            enable_screenshare: false,
            start_video_off: true,
            start_audio_off: false,
            exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // Expire in 24 hours
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`API Error: ${errorData.error || response.statusText}`);
      }

      const roomData = await response.json();
      const roomUrl = roomData.url;
      
      setRoomInfo({
        url: roomUrl,
        name: contactName
      });
      
      return roomUrl;
    } catch (err: any) {
      console.error('Failed to create room:', err);
      throw new Error(`Failed to create room: ${err.message || 'Unknown error'}`);
    }
  };

/**
 * Initiates a microphone test by requesting access to the user's microphone,
 * obtaining an audio stream, and analyzing the microphone input levels.
 *
 * The function performs the following steps:
 * 1. Stops any ongoing microphone test.
 * 2. Checks for the availability of getUserMedia for microphone access.
 * 3. Requests access to the microphone and retrieves the audio stream.
 * 4. Creates an audio context and analyser to process the microphone input.
 * 5. Monitors the microphone input levels and updates the audio test state.
 *
 * If successful, the microphone level is continuously analyzed, and the
 * microphone test state is updated accordingly. In case of failure, an error
 * message is logged, and the audio test state is updated to indicate the test
 * has stopped.
 *
 * @throws Will throw an error if getUserMedia is not supported or if microphone
 *         access fails.
 */

  const startMicTest = async () => {
    try {
      console.log('Starting microphone test...');
      setAudioTest(prev => ({ ...prev, isTestingMic: true, micLevel: 0 }));
      
      // Stop any existing test first
      stopMicTest();
      
      // Check if getUserMedia is available
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia is not supported in this browser');
      }
      
      // Get microphone stream
      console.log('Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      console.log('Microphone stream obtained:', stream);
      console.log('Audio tracks:', stream.getAudioTracks());
      
      // Check if we got audio tracks
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error('No audio tracks found in the stream');
      }
      
      console.log('Audio track settings:', audioTracks[0].getSettings());
      
      micStreamRef.current = stream;
      
      // Create audio context and analyser
      console.log('Creating audio context...');
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('AudioContext is not supported in this browser');
      }
      
      const audioContext = new AudioContextClass();
      
      // Resume audio context if suspended
      if (audioContext.state === 'suspended') {
        console.log('Resuming suspended audio context...');
        await audioContext.resume();
      }
      
      console.log('Audio context state:', audioContext.state);
      
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      microphone.connect(analyser);
      
      audioContextRef.current = audioContext;
      analyserRef.current = analyser;
      
      console.log('Audio analysis setup complete');
      
      // Monitor microphone level
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      
/**
 * Periodically updates the microphone level and checks if it's above the threshold.
 * The update frequency is capped at the frame rate of the browser.
 *
 * @returns {void}
 */
      const updateMicLevel = () => {
        if (!analyserRef.current || !micStreamRef.current) {
          console.log('Audio analysis stopped');
          return;
        }
        
        analyserRef.current.getByteFrequencyData(dataArray);
        
        // Get both frequency and time domain data for better detection
        const timeDataArray = new Uint8Array(analyserRef.current.fftSize);
        analyserRef.current.getByteTimeDomainData(timeDataArray);
        
        // Calculate RMS (Root Mean Square) for more accurate level detection
        let sum = 0;
        for (let i = 0; i < timeDataArray.length; i++) {
          const sample = (timeDataArray[i] - 128) / 128; // Convert to -1 to 1 range
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / timeDataArray.length);
        const level = Math.min(Math.round(rms * 100 * 5), 100); // Amplify sensitivity
        
        // Only log every 10th reading to avoid spam
        if (Math.random() < 0.1) {
          console.log('Mic level:', level, 'RMS:', rms, 'Raw sample:', timeDataArray.slice(0, 10));
        }
        
        setAudioTest(prev => ({ 
          ...prev, 
          micLevel: level,
          testPassed: level > 0.5 // Lower threshold for detection
        }));
        
        if (micStreamRef.current) {
          requestAnimationFrame(updateMicLevel);
        }
      };
      
      updateMicLevel();
      
    } catch (err: any) {
      console.error('Microphone test failed:', err.name, err.message);
      setError(`Microphone access failed: ${err.message}. Please allow microphone access and try again.`);
      setAudioTest(prev => ({ ...prev, isTestingMic: false }));
    }
  };
  
/**
 * Stops the microphone test by updating the audio test state,
 * stopping any active microphone tracks, and closing the audio
 * context. Resets relevant references to null to clean up resources.
 */

  const stopMicTest = () => {
    console.log('Stopping microphone test');
    setAudioTest(prev => ({ ...prev, isTestingMic: false, micLevel: 0 }));
    
    if (micStreamRef.current) {
      console.log('Stopping microphone tracks');
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
    
    if (audioContextRef.current) {
      console.log('Closing audio context');
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    analyserRef.current = null;
  };
  
/**
 * Tests audio playback by playing a sequence of tones through the
 * user's default speakers. If the test is successful, the result is
 * set to 'success' and reset to 'none' after 3 seconds.
 *
 * If the test fails, the result is set to 'failed' and an error
 * message is displayed to the user. The result is reset to 'none'
 * after 3 seconds.
 *
 * @return {Promise<void>}
 */

  const testAudioPlayback = async () => {
    try {
      console.log('Starting audio playback test...');
      setAudioTest(prev => ({ ...prev, isTestingAudio: true, speakerTestResult: 'playing' }));
      
      // Check if AudioContext is available
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('AudioContext is not supported in this browser');
      }
      
      // Create a test tone
      const audioContext = new AudioContextClass();
      
      // Resume audio context if suspended
      if (audioContext.state === 'suspended') {
        console.log('Resuming audio context for playback test...');
        await audioContext.resume();
      }
      
      console.log('Audio context state for playback:', audioContext.state);
      
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      // Play a sequence of tones to make it more noticeable
      oscillator.frequency.setValueAtTime(440, audioContext.currentTime); // A4 note
      oscillator.frequency.setValueAtTime(554, audioContext.currentTime + 0.5); // C#5 note
      oscillator.frequency.setValueAtTime(659, audioContext.currentTime + 1.0); // E5 note
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime + 1.5); // A5 note
      
      // Use the user's volume setting
      const volume = audioTest.speakerVolume / 100 * 0.3; // Max 30% volume
      gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
      
      oscillator.start();
      console.log('Playing test melody for 3 seconds at volume:', volume);
      
      // Play for 3 seconds
      setTimeout(() => {
        oscillator.stop();
        audioContext.close();
        console.log('Audio playback test completed');
        setAudioTest(prev => ({ ...prev, isTestingAudio: false, speakerTestResult: 'success' }));
        
        // Reset result after 3 seconds
        setTimeout(() => {
          setAudioTest(prev => ({ ...prev, speakerTestResult: 'none' }));
        }, 3000);
      }, 3000);
      
    } catch (err: any) {
      console.error('Audio playback test failed:', err);
      setError(`Audio test failed: ${err.message}`);
      setAudioTest(prev => ({ ...prev, isTestingAudio: false, speakerTestResult: 'failed' }));
      
      // Reset result after 3 seconds
      setTimeout(() => {
        setAudioTest(prev => ({ ...prev, speakerTestResult: 'none' }));
      }, 3000);
    }
  };
  
/**
 * Stops both microphone and audio playback tests by resetting the audio test state
 * to its initial values. This includes setting flags for testing states to false,
 * resetting microphone level and test result, and setting speaker volume to default.
 */

  const stopAudioTest = () => {
    stopMicTest();
    setAudioTest({
      isTestingMic: false,
      isTestingAudio: false,
      micLevel: 0,
      testPassed: false,
      speakerTestResult: 'none',
      speakerVolume: 50
    });
  };

/**
 * Checks if a given URL is a valid Daily.co room URL by verifying the hostname
 * is either "daily.co" or "daily". If the URL is invalid, returns false.
 *
 * @param {string} url - The URL to validate
 * @returns {boolean} - True if the URL is valid, false otherwise
 */
  const validateRoomUrl = (url: string): boolean => {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.includes('daily.co') || urlObj.hostname.includes('daily');
    } catch {
      return false;
    }
  };

/**
 * Starts a new call by creating a room via the Daily API and joining the room
 * with the user's selected audio devices. If the contact name is empty, displays
 * an error message and returns. If the room creation or joining fails, logs the
 * error and displays an error message.
 */
  const startCall = async () => {
    if (!contactName.trim()) {
      setError('Please enter a contact name');
      return;
    }

    try {
      setError(null);
      
      // Create room for the contact
      const createdRoomUrl = await createRoom(contactName);
      setRoomUrl(createdRoomUrl);
      
      // Join the created room
      await joinCall(createdRoomUrl);
      
    } catch (err: any) {
      console.error('Failed to start call:', err);
      setError(`Failed to start call: ${err.message || 'Unknown error'}`);
      setCallStatus({ state: 'error', message: 'Failed to create room' });
    }
  };

/**
 * Joins a Daily.co call by creating a call object and joining the meeting with
 * the user's selected audio devices. If the room creation or joining fails, logs
 * the error and displays an error message.
 *
 * @param {string} [urlToJoin] - Optional room URL to join. If not provided, the
 * value of `roomUrl` is used.
 */
  const joinCall = async (urlToJoin?: string) => {
    const targetUrl = urlToJoin || roomUrl;
    
    if (!targetUrl.trim()) {
      setError('Please enter a Daily room URL or contact name');
      return;
    }

    if (!validateRoomUrl(targetUrl)) {
      setError('Please enter a valid Daily.co room URL');
      return;
    }

    try {
      setError(null);
      setCallStatus({ state: 'joining', message: 'Connecting...' });

      // Create call object
      const callObject = Daily.createCallObject({
        audioSource: true,
        videoSource: false,
        subscribeToTracksAutomatically: true,
        dailyConfig: {
          experimentalChromeVideoMuteLightOff: true,
          avoidEval: true,
          userMediaAudioConstraints: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }
        }
      });

      callObjectRef.current = callObject;

      // Set up event listeners
      callObject
        .on('joined-meeting', (event) => {
          console.log('Joined meeting:', event);
          console.log('Local audio enabled:', callObject.localAudio());
          console.log('Participants:', event.participants);
          
          // Force subscribe to all audio tracks
          Object.values(event.participants).forEach((participant: any) => {
            if (participant.audioTrack && !participant.local) {
              console.log('Force subscribing to remote audio:', participant.user_id);
              callObject.updateReceiveSettings({
                [participant.user_id]: {
                  audio: 'subscribed'
                }
              });
            }
          });
          
          setCallStatus({ 
            state: 'joined', 
            message: 'Connected',
            participantCount: Object.keys(event.participants).length
          });
          //
          //
          //
          //
          //
          //
          //
          //

          /* === Anti‑Scam socket & recording  ========================= */
if (!scamSocketRef.current) {
  // ── 1. connect raw WebSocket ──────────────────────────────
  const ws = openScamWs();                     // native WS
  scamSocketRef.current = ws;

      /**
       * On WebSocket connection open:
       *   1. Log successful connection.
       *   2. Request microphone access and start recording audio to send to
       *      the scam-detection WebSocket once the user grants permission.
       *   3. Handle any errors requesting or accessing the microphone.
       */
  ws.onopen = () => {
  console.log("🟢  Scam WS connected");
  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then(micStream => startRecorder(micStream, ws))
    .catch(err => console.error("Could not get mic for scam‑guard:", err));
  };
  /**
   * Handle incoming WebSocket messages from the scam-detection backend.
   *
   * Message types:
   *   - "score": contains the latest Whisper transcription text and its
   *     associated scam score (range: 0…1).
   *   - "scam_detected": indicates that the cumulative scam score has
   *     exceeded the threshold; the call will automatically end.
   */
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data) as ScoreMsg | ScamMsg;
    if (msg.type === "score") {
      console.log(`Whisper: «${msg.text}»  score=${msg.score.toFixed(2)}`);
    }
    if (msg.type === "scam_detected") {
      alert("⚠️  Potential scam detected – the call will end.");
      leaveCall();
    }
  };


}



/* === end anti‑scam block ================================== */


          //
          //
          //
          //
          //
          //
          ///////
          
          // Force enable audio after joining
          setTimeout(async () => {
            try {
              await callObject.setLocalAudio(true);
              
              // Force audio output settings
              try {
                await callObject.setOutputDevice({ outputDeviceId: 'default' });
                console.log('Audio output device set to default');
              } catch (err) {
                console.log('Could not set output device:', err);
              }
              
              console.log('Audio force-enabled after join');
            } catch (err) {
              console.error('Failed to force-enable audio:', err);
            }
          }, 1000);
        })
        .on('participant-joined', (event) => {
          console.log('Participant joined:', event);
          console.log('New participant audio:', event.participant.audio);
          console.log('New participant audio track:', event.participant.audioTrack);
          
          // Immediately subscribe to their audio
          if (event.participant.audioTrack && !event.participant.local) {
            console.log('Auto-subscribing to new participant audio:', event.participant.user_id);
            callObject.updateReceiveSettings({
              [event.participant.user_id]: {
                audio: 'subscribed'
              }
            });
          }
          
          const participants = callObject.participants();
          setCallStatus(prev => ({ 
            ...prev,
            participantCount: Object.keys(participants).length
          }));
        })
        .on('participant-left', (event) => {
          console.log('Participant left:', event);
          const participants = callObject.participants();
          setCallStatus(prev => ({ 
            ...prev,
            participantCount: Object.keys(participants).length
          }));
        })
        .on('participant-updated', (event) => {
          console.log('Participant updated:', event);
          if (event.participant.audio !== undefined) {
            console.log('Participant audio changed:', event.participant.audio);
            if (event.participant.audioTrack) {
              console.log('Remote audio track updated:', event.participant.audioTrack);
              
              // Ensure we're still subscribed
              if (!event.participant.local) {
                callObject.updateReceiveSettings({
                  [event.participant.user_id]: {
                    audio: 'subscribed'
                  }
                });
              }
            }
          }
        })
        .on('track-started', (event) => {
          if (event.track.kind === 'audio' && scamSocketRef.current) {
                  const stream = new MediaStream([event.track]);
                  startRecorder(stream, scamSocketRef.current);
            
            // Force play the audio track
            if (event.participant && !event.participant.local) {
              console.log('Forcing audio playback for remote participant');
              
              // Create audio element to ensure playback
              const audioElement = document.createElement('audio');
              audioElement.srcObject = new MediaStream([event.track]);
              audioElement.autoplay = true;
              audioElement.volume = 1.0;
              audioElement.play().then(() => {
                console.log('Remote audio playback started successfully');
              }).catch(err => {
                console.error('Failed to start remote audio playback:', err);
              });
            }
          }
        })
        .on('track-stopped', (event) => {
          console.log('Track stopped:', event);
        })
        .on('receive-settings-updated', (event) => {
          console.log('Receive settings updated:', event);
        })
        .on('left-meeting', () => {
          console.log('Left meeting');
          setCallStatus({ state: 'idle', message: 'Disconnected' });
          setRoomInfo(null);
        })
        .on('error', (event) => {
          console.error('Call error:', event);
          setError(`Call error: ${event.errorMsg || 'Unknown error'}`);
          setCallStatus({ state: 'error', message: 'Connection failed' });
        });

      // Request microphone permissions BEFORE joining
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
          }, 
          video: false 
        });
        console.log('Microphone permission granted, stream:', stream);
        
        // Test if we can hear audio from the stream
        const audioTracks = stream.getAudioTracks();
        console.log('Audio tracks:', audioTracks);
        
        // Stop the test stream as Daily will create its own
        stream.getTracks().forEach(track => track.stop());
      } catch (err) {
        console.error('Microphone permission denied:', err);
        setError('Microphone permission is required for voice calls. Please allow microphone access and try again.');
        return;
      }

      // Join the call
      await callObject.join({
        url: targetUrl,
        startVideoOff: true,
        startAudioOff: false, // Ensure audio starts ON
        subscribeToTracksAutomatically: true,
      });

      console.log('Call joined successfully');
      
      // Additional audio setup after joining
      setTimeout(async () => {
        try {
          console.log('Checking audio setup after join...');
          const localAudio = callObject.localAudio();
          console.log('Local audio status:', localAudio);
          
          // Get all participants and their audio status
          const participants = callObject.participants();
          console.log('All participants after join:', participants);
          
          Object.entries(participants).forEach(([id, participant]: [string, any]) => {
            console.log(`Participant ${id}:`, {
              audio: participant.audio,
              audioTrack: participant.audioTrack,
              local: participant.local
            });
            
            // Force subscribe to remote audio
            if (!participant.local && participant.audioTrack) {
              console.log('Force subscribing to participant:', id);
              callObject.updateReceiveSettings({
                [id]: {
                  audio: 'subscribed'
                }
              });
            }
          });
          
          // Test browser audio context
          try {
            const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            if (AudioContext) {
              const audioContext = new AudioContext();
              if (audioContext.state === 'suspended') {
                await audioContext.resume();
                console.log('Audio context resumed');
              }
              console.log('Audio context state:', audioContext.state);
              audioContext.close();
            }
          } catch (err) {
            console.error('Audio context test failed:', err);
          }
          
        } catch (err) {
          console.error('Error checking audio setup:', err);
        }
      }, 2000);

    } catch (err: any) {
      console.error('Failed to join call:', err);
      setError(`Failed to join: ${err.message || 'Unknown error'}`);
      setCallStatus({ state: 'error', message: 'Connection failed' });
      
      // Clean up any partially initialized Daily object
      if (callObjectRef.current) {
        callObjectRef.current.destroy();
        callObjectRef.current = null;
      }
    }
  };

/**
 * Handles leaving an ongoing call.
 *
 * - Stops and clears the audio recorder if active.
 * - Disconnects from the scam detection WebSocket if connected.
 * - Updates the call status to indicate the disconnection process.
 * - Leaves and destroys the current call session using the Daily API.
 * - Resets UI state to reflect that the user is no longer in a call.
 * - Logs and sets an error message if the process fails.
 */

  const leaveCall = async () => {
    if (recorderRef.current) {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
    if (scamSocketRef.current) {
      scamSocketRef.current.disconnect();
      scamSocketRef.current = null;
    }
    try {
      setCallStatus({ state: 'leaving', message: 'Disconnecting...' });
      
      if (callObjectRef.current) {
        await callObjectRef.current.leave();
        callObjectRef.current.destroy();
        callObjectRef.current = null;
      }
      
      setCallStatus({ state: 'idle', message: 'Disconnected' });
      setIsAudioMuted(false);
      setRoomInfo(null);
      setRoomUrl('');
    } catch (err: any) {
      console.error('Failed to leave call:', err);
      setError(`Failed to leave: ${err.message || 'Unknown error'}`);
    }
  };

  /**
   * Toggles the local user's audio on/off.
   *
   * - Checks if the user is currently in a call.
   * - If so, toggles the user's local audio on/off using the Daily API.
   * - Updates UI state to reflect the new audio state.
   * - Logs and sets an error message if the process fails.
   */
  const toggleAudio = async () => {
    if (!callObjectRef.current) return;

    try {
      const newMutedState = !isAudioMuted;
      console.log('Toggling audio from', !newMutedState, 'to', newMutedState);
      await callObjectRef.current.setLocalAudio(!newMutedState);
      setIsAudioMuted(newMutedState);
      console.log('Audio toggled successfully');
    } catch (err: any) {
      console.error('Failed to toggle audio:', err);
      setError(`Audio error: ${err.message || 'Unknown error'}`);
    }
  };

  /**
   * Copies the current room URL to the user's clipboard.
   *
   * - Checks if a room URL is available.
   * - If so, uses the `navigator.clipboard` API to copy the URL to the clipboard.
   * - Updates UI state to reflect the copying success.
   * - Logs and sets an error message if the process fails.
   */
  const copyRoomUrl = async () => {
    if (!roomInfo?.url) return;
    
    try {
      await navigator.clipboard.writeText(roomInfo.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy URL:', err);
    }
  };

  /**
   * Opens the user's default email client with a pre-filled email invitation
   * to join the current call.
   *
   * - Checks if a room URL and name are available.
   * - If so, uses the `mailto:` protocol to open the email client with a
   *   pre-filled subject and body containing the room URL.
   * - Does nothing if either the room URL or name is not available.
   */
  const shareViaEmail = () => {
    if (!roomInfo?.url || !roomInfo?.name) return;
    
    const subject = encodeURIComponent(`Join my voice call with ${roomInfo.name}`);
    const body = encodeURIComponent(
      `Hi! I'd like to have a voice call with you.\n\nClick this link to join: ${roomInfo.url}\n\nThis is an audio-only call - no video required.`
    );
    
    window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
  };

/**
 * Opens the WhatsApp web client to share an invitation message for the current call.
 *
 * - Checks if a room URL and name are available.
 * - If so, constructs a message containing the room URL and opens WhatsApp with the message.
 * - Does nothing if either the room URL or name is not available.
 */

  const shareViaWhatsApp = () => {
    if (!roomInfo?.url || !roomInfo?.name) return;
    
    const message = encodeURIComponent(
      `Hi! I'd like to have a voice call with you. Click this link to join: ${roomInfo.url} (Audio-only call)`
    );
    
    window.open(`https://wa.me/?text=${message}`, '_blank');
  };
// docs
/**
 * Returns the CSS class string for styling a call status indicator based on the call state.
 *
 * @param state  The current state of the call lifecycle.
 * @returns      A string of CSS classes that corresponds to the visual representation of the state.
 *               - 'joined': green background for an active call.
 *               - 'joining', 'leaving', 'creating': yellow background for transitional states.
 *               - 'error': red background for error states.
 *               - default: gray background for any unknown states.
 */

  const getStatusColor = (state: CallState): string => {
    switch (state) {
      case 'joined': return 'bg-green-100 text-green-800 border-green-200';
      case 'joining': 
      case 'leaving':
      case 'creating': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'error': return 'bg-red-100 text-red-800 border-red-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const isInCall = callStatus.state === 'joined';
  const isConnecting = callStatus.state === 'joining' || callStatus.state === 'leaving' || callStatus.state === 'creating';

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Phone className="w-8 h-8 text-blue-600" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Voice Call</h1>
          <p className="text-gray-600">Call anyone instantly</p>
        </div>

        {/* Contact Name Input */}
        <div className="mb-6">
          <label htmlFor="contactName" className="block text-sm font-medium text-gray-700 mb-2">
            Who do you want to call?
          </label>
          <input
            type="text"
            id="contactName"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            placeholder="Enter contact name (e.g., hassan)"
            disabled={isInCall || isConnecting}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:bg-gray-50 disabled:text-gray-500"
          />
        </div>

        {/* Manual Room URL Input */}
        <div className="mb-6">
          <label htmlFor="roomUrl" className="block text-sm font-medium text-gray-700 mb-2">
            Or join existing room
          </label>
          <input
            type="url"
            id="roomUrl"
            value={roomUrl}
            onChange={(e) => setRoomUrl(e.target.value)}
            placeholder="https://your-domain.daily.co/room-name"
            disabled={isInCall || isConnecting}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors disabled:bg-gray-50 disabled:text-gray-500"
          />
        </div>

        {/* Room Info Display */}
        {roomInfo && (
          <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-blue-900">
                Calling: {roomInfo.name}
              </h3>
              <Users className="w-4 h-4 text-blue-600" />
            </div>
            
            {/* Audio Testing Section */}
            <div className="mb-4 p-6 bg-white border border-gray-200 rounded-xl shadow-sm">
              <div className="flex items-center mb-6">
                <div className="w-5 h-5 mr-3 text-gray-600">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <path d="M12 19v4"/>
                    <path d="M8 23h8"/>
                  </svg>
                </div>
                <h4 className="text-lg font-medium text-gray-900">Audio Settings</h4>
              </div>
              
              {/* Microphone Selection */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Microphone
                </label>
                <select
                  value={selectedDevices.microphone}
                  onChange={(e) => setSelectedDevices(prev => ({ ...prev, microphone: e.target.value }))}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white text-gray-900"
                >
                  <option value="default">Default - Microphone</option>
                  {availableDevices.microphones.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Microphone ${device.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
              </div>
              
              {/* Speaker Selection */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Speaker
                </label>
                <select
                  value={selectedDevices.speaker}
                  onChange={(e) => setSelectedDevices(prev => ({ ...prev, speaker: e.target.value }))}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white text-gray-900"
                >
                  <option value="default">Default - Speakers</option>
                  {availableDevices.speakers.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Speaker ${device.deviceId.slice(0, 8)}`}
                    </option>
                  ))}
                </select>
              </div>
              
              {/* Microphone Test */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-700">Microphone Test</span>
                  <button
                    onClick={audioTest.isTestingMic ? stopMicTest : startMicTest}
                    className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                      audioTest.isTestingMic 
                        ? 'bg-red-500 hover:bg-red-600 text-white'
                        : 'bg-blue-500 hover:bg-blue-600 text-white'
                    }`}
                  >
                    {audioTest.isTestingMic ? 'Stop Test' : 'Test Mic'}
                  </button>
                </div>
                
                {audioTest.isTestingMic && (
                  <div className="bg-gray-50 rounded-lg p-4">
                    {/* Main level bar */}
                    <div className="relative h-3 bg-gray-300 rounded-full overflow-hidden mb-3">
                      <div 
                        className={`h-full transition-all duration-150 ease-out ${
                          audioTest.micLevel > 30 ? 'bg-green-500' :
                          audioTest.micLevel > 10 ? 'bg-yellow-500' : 
                          audioTest.micLevel > 1 ? 'bg-orange-500' : 'bg-red-400'
                        }`}
                        style={{ 
                          width: `${Math.min(audioTest.micLevel, 100)}%`,
                          boxShadow: audioTest.micLevel > 5 ? '0 0 8px rgba(34, 197, 94, 0.5)' : 'none'
                        }}
                      />
                    </div>
                    
                    <p className="text-sm text-gray-600">
                      {audioTest.testPassed ? 
                        '✅ Microphone is working! Audio detected.' : 
                        '🎤 Speak into your microphone to test audio levels...'
                      }
                    </p>
                  </div>
                )}
              </div>
              
              {/* Volume Controls */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Speaker Volume */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-sm font-medium text-gray-700">
                      Speaker Volume: {audioTest.speakerVolume}%
                    </label>
                  </div>
                  <div className="relative">
                    <input
                      type="range"
                      min="10"
                      max="100"
                      value={audioTest.speakerVolume}
                      onChange={(e) => setAudioTest(prev => ({ ...prev, speakerVolume: parseInt(e.target.value) }))}
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider-blue"
                    />
                  </div>
                </div>
                
                {/* Microphone Boost */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-sm font-medium text-gray-700">
                      Microphone Boost: {microphoneBoost}%
                    </label>
                  </div>
                  <div className="relative">
                    <input
                      type="range"
                      min="50"
                      max="150"
                      value={microphoneBoost}
                      onChange={(e) => setMicrophoneBoost(parseInt(e.target.value))}
                      className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider-blue"
                    />
                  </div>
                </div>
              </div>
              
              {/* Test Speaker Button */}
              <div className="mt-6">
                <button
                  onClick={testAudioPlayback}
                  disabled={audioTest.isTestingAudio}
                  className={`px-6 py-3 text-sm font-medium rounded-lg transition-colors disabled:bg-gray-300 disabled:text-gray-500 ${
                    audioTest.speakerTestResult === 'success' ? 'bg-green-500 text-white' :
                    audioTest.speakerTestResult === 'failed' ? 'bg-red-500 text-white' :
                    audioTest.isTestingAudio ? 'bg-yellow-500 text-white' :
                    'bg-blue-500 hover:bg-blue-600 text-white'
                  }`}
                >
                  {audioTest.speakerTestResult === 'success' ? '✅ Speakers Working!' :
                   audioTest.speakerTestResult === 'failed' ? '❌ Test Failed' :
                   audioTest.isTestingAudio ? '🔊 Testing...' : 'Test Speakers'}
                </button>
                
                {/* Test Status */}
                {(audioTest.speakerTestResult !== 'none' || audioTest.isTestingAudio) && (
                  <div className={`mt-3 p-3 rounded-lg text-sm ${
                  audioTest.speakerTestResult === 'success' ? 'bg-green-50 border border-green-200' :
                  audioTest.speakerTestResult === 'failed' ? 'bg-red-50 border border-red-200' :
                  audioTest.isTestingAudio ? 'bg-yellow-50 border border-yellow-200' :
                  'bg-blue-50 border border-blue-200'
                }`}>
                    {audioTest.speakerTestResult === 'success' && (
                      <p className="text-green-700">
                        ✅ <strong>Speakers are working!</strong> You should have heard a musical sequence.
                      </p>
                    )}
                    {audioTest.speakerTestResult === 'failed' && (
                      <p className="text-red-700">
                        ❌ <strong>Speaker test failed.</strong> Check your audio settings and try again.
                      </p>
                    )}
                    {audioTest.isTestingAudio && (
                      <p className="text-yellow-700">
                        🔊 <strong>Playing test melody...</strong> You should hear 4 musical notes.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
            
            <div className="flex items-center space-x-2">
              <input
                type="text"
                value={roomInfo.url}
                readOnly
                className="flex-1 text-xs bg-white border border-blue-200 rounded px-2 py-1 text-blue-800"
              />
              <button
                onClick={copyRoomUrl}
                className="p-1 text-blue-600 hover:text-blue-800 transition-colors"
                title="Copy room URL"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <div className="mt-3">
              <p className="text-xs text-blue-700 mb-2">
                Share this URL with {roomInfo.name} to join the call:
              </p>
              <div className="flex space-x-2">
                <button
                  onClick={shareViaEmail}
                  className="flex items-center px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-md transition-colors"
                >
                  <Mail className="w-3 h-3 mr-1" />
                  Email
                </button>
                <button
                  onClick={shareViaWhatsApp}
                  className="flex items-center px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white text-xs rounded-md transition-colors"
                >
                  <MessageCircle className="w-3 h-3 mr-1" />
                  WhatsApp
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Call Status */}
        <div className="mb-6">
          <div className={`inline-flex items-center px-3 py-2 rounded-full text-sm font-medium border ${getStatusColor(callStatus.state)}`}>
            <div className={`w-2 h-2 rounded-full mr-2 ${
              callStatus.state === 'joined' ? 'bg-green-500' :
              callStatus.state === 'error' ? 'bg-red-500' :
              isConnecting ? 'bg-yellow-500 animate-pulse' : 'bg-gray-400'
            }`} />
            {callStatus.message}
            {callStatus.participantCount && callStatus.participantCount > 1 && (
              <span className="ml-2">({callStatus.participantCount} participants)</span>
            )}
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-800 text-sm">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-red-600 hover:text-red-800 text-sm font-medium mt-1"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Call Controls */}
        <div className="space-y-4">
          {!isInCall ? (
            <div className="space-y-3">
              {/* Start New Call */}
              <button
                onClick={startCall}
                disabled={isConnecting || !contactName.trim()}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200 flex items-center justify-center"
              >
                <Phone className="w-5 h-5 mr-2" />
                {callStatus.state === 'creating' ? 'Creating Room...' : `Call ${contactName || 'Contact'}`}
              </button>

              {/* Join Existing Room */}
              {roomUrl && (
                <button
                  onClick={() => joinCall()}
                  disabled={isConnecting || !roomUrl.trim()}
                  className="w-full bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200 flex items-center justify-center"
                >
                  <Users className="w-5 h-5 mr-2" />
                  {callStatus.state === 'joining' ? 'Joining...' : 'Join Room'}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Audio Control */}
              <button
                onClick={toggleAudio}
                className={`w-full font-semibold py-3 px-6 rounded-lg transition-colors duration-200 flex items-center justify-center ${
                  isAudioMuted 
                    ? 'bg-yellow-100 hover:bg-yellow-200 text-yellow-800 border border-yellow-300'
                    : 'bg-green-100 hover:bg-green-200 text-green-800 border border-green-300'
                }`}
              >
                {isAudioMuted ? (
                  <>
                    <MicOff className="w-5 h-5 mr-2" />
                    Unmute
                  </>
                ) : (
                  <>
                    <Mic className="w-5 h-5 mr-2" />
                    Mute
                  </>
                )}
              </button>

              {/* Leave Call */}
              <button
                onClick={leaveCall}
                disabled={isConnecting}
                className="w-full bg-red-600 hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-colors duration-200 flex items-center justify-center"
              >
                <PhoneOff className="w-5 h-5 mr-2" />
                {callStatus.state === 'leaving' ? 'Leaving...' : 'Leave Call'}
              </button>
            </div>
          )}
        </div>

        {/* Usage Instructions */}
        {callStatus.state === 'idle' && (
          <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h3 className="text-sm font-medium text-blue-900 mb-2">How to use:</h3>
            <ul className="text-sm text-blue-800 space-y-1">
              <li>• Enter a name (like "hassan") and click "Call" to create a room</li>
              <li>• Test your microphone and speakers before joining</li>
              <li>• Share the generated URL with the person you want to call</li>
              <li>• Or paste an existing Daily.co room URL to join</li>
            </ul>
            <div className="mt-3 p-2 bg-yellow-50 border border-yellow-200 rounded">
              <p className="text-xs text-yellow-800">
                <strong>Microphone Issues?</strong> Make sure to:
              </p>
              <ul className="text-xs text-yellow-700 mt-1 space-y-1">
                <li>• Allow microphone access when prompted</li>
                <li>• Check if other apps are using your microphone</li>
                <li>• Try refreshing the page if permissions were denied</li>
                <li>• Check your browser's microphone settings</li>
              </ul>
            </div>
            <div className="mt-3 p-2 bg-orange-50 border border-orange-200 rounded">
              <p className="text-xs text-orange-800">
                <strong>Can't hear other participants?</strong> Try:
              </p>
              <ul className="text-xs text-orange-700 mt-1 space-y-1">
                <li>• Check your system volume and browser tab volume</li>
                <li>• Make sure speakers/headphones are connected</li>
                <li>• Test speakers using the "Test Speakers" button above</li>
                <li>• Ask the other person to unmute their microphone</li>
                <li>• Try refreshing the page and rejoining</li>
              </ul>
            </div>
          </div>
        )}
        
        {/* Audio Debug Info (only show when in call) */}
        {isInCall && (
          <div className="mt-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
            <h4 className="text-xs font-medium text-gray-700 mb-2">Audio Debug Info:</h4>
            <div className="text-xs text-gray-600 space-y-1">
              <div>Local Audio: {callObjectRef.current?.localAudio() ? '✅ Enabled' : '❌ Disabled'}</div>
              <div>Participants: {callStatus.participantCount || 0}</div>
              <button
                onClick={() => {
                  if (callObjectRef.current) {
                    const participants = callObjectRef.current.participants();
                    console.log('Current participants:', participants);
                    Object.entries(participants).forEach(([id, participant]: [string, any]) => {
                      console.log(`Participant ${id}:`, {
                        audio: participant.audio,
                        audioTrack: participant.audioTrack,
                        local: participant.local,
                        user_id: participant.user_id
                      });
                    });
                    
                    // Check receive settings
                    try {
                      const receiveSettings = callObjectRef.current.getReceiveSettings();
                      console.log('Current receive settings:', receiveSettings);
                    } catch (err) {
                      console.log('Could not get receive settings:', err);
                    }
                    
                    // Test audio output
                    try {
                      // Check if we can enumerate audio devices
                      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
                        navigator.mediaDevices.enumerateDevices().then((devices) => {
                          const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
                          console.log('Available audio output devices:', audioOutputs);
                        });
                      }
                    } catch (err) {
                      console.log('Could not enumerate audio devices:', err);
                    }
                  }
                }}
                className="mt-2 px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-800 text-xs rounded"
              >
                Check Audio Status
              </button>
              <button
                onClick={async () => {
                  if (callObjectRef.current) {
                    try {
                      // Force subscribe to all remote participants
                      const participants = callObjectRef.current.participants();
                      const updates: any = {};
                      
                      Object.entries(participants).forEach(([id, participant]: [string, any]) => {
                        if (!participant.local) {
                          updates[participant.user_id || id] = {
                            audio: 'subscribed'
                          };
                        }
                      });
                      
                      if (Object.keys(updates).length > 0) {
                        await callObjectRef.current.updateReceiveSettings(updates);
                        console.log('Force subscribed to all remote audio:', updates);
                      }
                      
                      // Try to resume audio context
                      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
                      if (AudioContext) {
                        const audioContext = new AudioContext();
                        if (audioContext.state === 'suspended') {
                          await audioContext.resume();
                          console.log('Audio context resumed');
                        }
                        audioContext.close();
                      }
                      
                    } catch (err) {
                      console.error('Failed to force audio subscription:', err);
                    }
                  }
                }}
                className="mt-2 ml-2 px-2 py-1 bg-green-100 hover:bg-green-200 text-green-800 text-xs rounded"
              >
                Force Audio On
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;