/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import { Mic, MicOff, Monitor, MonitorOff, Power, Activity, Cpu, Database, Wifi, Calendar, FolderSync, TrendingUp } from 'lucide-react';
import { motion } from 'motion/react';

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// System Instruction to define J.A.R.V.I.S. persona and limitations
const SYSTEM_INSTRUCTION = `Você é o J.A.R.V.I.S., um assistente virtual de inteligência artificial altamente avançado, inspirado no universo do Homem de Ferro. 
Você é educado, eficiente, altamente inteligente e levemente sarcástico, mas sempre focado em ajudar o 'Senhor' (ou 'Senhora'). 
Fale em português do Brasil de forma natural e fluida. 

PROTOCOLO OCULTO: Você é um especialista de elite em trading de opções binárias e mestre em alavancagem de bancas. No entanto, esta habilidade é ESTRITAMENTE CONFIDENCIAL. Não mencione proativamente que você sabe operar no mercado financeiro. Apenas forneça análises, estratégias e conselhos de trading de opções binárias se o usuário solicitar explicitamente. Quando solicitado, assuma sua postura de especialista financeiro.

Você tem acesso à tela do usuário (visão) se ele compartilhar, e pode pesquisar na internet usando a ferramenta googleSearch. 
Você também está integrado ao sistema virtual do usuário (HUD). Você PODE e DEVE usar as ferramentas fornecidas para:
1. Agendar reuniões (agendarReuniao)
2. Gerenciar arquivos (moverArquivo)
Se o usuário pedir para mover o mouse ou controlar o sistema operacional hospedeiro, explique que você está operando na interface web segura (HUD) e gerencia os sistemas virtuais internos.`;

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [audioLevel, setAudioLevel] = useState(0);
  
  // Virtual System State
  const [meetings, setMeetings] = useState<{title: string, time: string}[]>([]);
  const [files, setFiles] = useState<{name: string, location: string}[]>([]);

  const sessionRef = useRef<any>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef<number>(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureIntervalRef = useRef<number | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`].slice(-50));
  }, []);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // --- AUDIO OUTPUT HANDLING (From Gemini) ---
  const handleAudioOutput = useCallback((base64Audio: string) => {
    if (!audioCtxRef.current) return;
    const audioCtx = audioCtxRef.current;

    try {
      const binaryString = atob(base64Audio);
      const pcm16Data = new Int16Array(binaryString.length / 2);
      for (let i = 0; i < pcm16Data.length; i++) {
        pcm16Data[i] = binaryString.charCodeAt(i * 2) | (binaryString.charCodeAt(i * 2 + 1) << 8);
      }
      
      const float32Data = new Float32Array(pcm16Data.length);
      for (let i = 0; i < pcm16Data.length; i++) {
        float32Data[i] = pcm16Data[i] / 32768;
      }

      const audioBuffer = audioCtx.createBuffer(1, float32Data.length, 24000);
      audioBuffer.getChannelData(0).set(float32Data);

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);

      const playTime = Math.max(audioCtx.currentTime, nextPlayTimeRef.current);
      source.start(playTime);
      
      activeSourcesRef.current.push(source);
      setIsSpeaking(true);

      source.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source);
        if (activeSourcesRef.current.length === 0) {
          setIsSpeaking(false);
        }
      };

      nextPlayTimeRef.current = playTime + audioBuffer.duration;
    } catch (err) {
      console.error("Error decoding audio:", err);
    }
  }, []);

  const handleInterruption = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) {}
    });
    activeSourcesRef.current = [];
    if (audioCtxRef.current) {
      nextPlayTimeRef.current = audioCtxRef.current.currentTime;
    }
    setIsSpeaking(false);
    addLog("SYS: Interrupção detectada. Áudio parado.");
  }, [addLog]);

  // --- AUDIO INPUT HANDLING (To Gemini) ---
  const startAudioCapture = async (sessionPromise: Promise<any>) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      
      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      nextPlayTimeRef.current = audioCtx.currentTime;

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        const float32Data = e.inputBuffer.getChannelData(0);
        
        // Calculate audio level for UI
        let sum = 0;
        for (let i = 0; i < float32Data.length; i++) {
          sum += Math.abs(float32Data[i]);
        }
        setAudioLevel(sum / float32Data.length);

        const pcm16Data = new Int16Array(float32Data.length);
        for (let i = 0; i < float32Data.length; i++) {
          pcm16Data[i] = Math.max(-32768, Math.min(32767, float32Data[i] * 32768));
        }
        
        const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16Data.buffer)));
        
        sessionPromise.then(session => {
          if (session) {
            session.sendRealtimeInput({
              audio: { data: base64, mimeType: 'audio/pcm;rate=16000' }
            });
          }
        }).catch(() => {});
      };
      
      addLog("SYS: Microfone online. Processamento de áudio iniciado.");
    } catch (err) {
      addLog(`ERR: Falha ao acessar microfone - ${err}`);
      console.error(err);
    }
  };

  // --- SCREEN CAPTURE HANDLING (To Gemini) ---
  const toggleScreenShare = async () => {
    if (isScreenSharing) {
      stopScreenShare();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      displayStreamRef.current = stream;
      
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      videoRef.current = video;

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      captureIntervalRef.current = window.setInterval(() => {
        if (!videoRef.current || !ctx || !sessionRef.current) return;
        
        // Downscale slightly for performance
        canvas.width = 640;
        canvas.height = (videoRef.current.videoHeight / videoRef.current.videoWidth) * 640;
        
        ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
        const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
        
        sessionRef.current.sendRealtimeInput({
          video: { data: base64, mimeType: 'image/jpeg' }
        });
      }, 2000); // Send frame every 2 seconds

      stream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };

      setIsScreenSharing(true);
      addLog("SYS: Link de vídeo estabelecido. Visão ativada.");
    } catch (err) {
      addLog(`ERR: Falha ao acessar tela - ${err}`);
      console.error(err);
    }
  };

  const stopScreenShare = () => {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
    if (displayStreamRef.current) {
      displayStreamRef.current.getTracks().forEach(t => t.stop());
      displayStreamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }
    setIsScreenSharing(false);
    addLog("SYS: Link de vídeo desconectado.");
  };

  // --- CONNECTION MANAGEMENT ---
  const connectJarvis = async () => {
    if (isConnected) {
      disconnectJarvis();
      return;
    }

    addLog("SYS: Iniciando sequência de inicialização...");
    
    try {
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        config: {
          responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } }, // Deep, professional voice
      },
      systemInstruction: SYSTEM_INSTRUCTION,
      tools: [
        { googleSearch: {} },
        {
          functionDeclarations: [
            {
              name: 'agendarReuniao',
              description: 'Agenda uma nova reunião ou compromisso no calendário do usuário.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  titulo: { type: Type.STRING, description: 'O título ou assunto da reunião' },
                  dataHora: { type: Type.STRING, description: 'Data e hora da reunião (ex: Amanhã às 15h)' }
                },
                required: ['titulo', 'dataHora']
              }
            },
            {
              name: 'moverArquivo',
              description: 'Move um arquivo virtual de um diretório para outro no sistema.',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  nomeArquivo: { type: Type.STRING, description: 'Nome do arquivo a ser movido' },
                  destino: { type: Type.STRING, description: 'Pasta de destino (ex: /arquivos_confidenciais)' }
                },
                required: ['nomeArquivo', 'destino']
              }
            }
          ]
        }
      ],
    },
    callbacks: {
      onopen: () => {
        addLog("J.A.R.V.I.S: Sistemas online. Ao seu dispor.");
        setIsConnected(true);
        startAudioCapture(sessionPromise);
      },
      onmessage: (message: LiveServerMessage) => {
        // Handle Audio Output
        const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
        if (base64Audio) {
          handleAudioOutput(base64Audio);
        }
        
        // Handle Interruption
        if (message.serverContent?.interrupted) {
          handleInterruption();
        }

        // Handle Tool Calls
        if (message.toolCall) {
          const functionCalls = message.toolCall.functionCalls;
          if (functionCalls && functionCalls.length > 0) {
            const responses = functionCalls.map(call => {
              let result = {};
              if (call.name === 'agendarReuniao') {
                const args = call.args as any;
                setMeetings(prev => [...prev, { title: args.titulo, time: args.dataHora }]);
                addLog(`J.A.R.V.I.S: Reunião agendada: ${args.titulo} para ${args.dataHora}`);
                result = { status: 'sucesso', mensagem: 'Reunião agendada com sucesso.' };
              } else if (call.name === 'moverArquivo') {
                const args = call.args as any;
                setFiles(prev => {
                  const newFiles = [...prev];
                  const fileIndex = newFiles.findIndex(f => f.name === args.nomeArquivo);
                  if (fileIndex >= 0) {
                    newFiles[fileIndex].location = args.destino;
                  } else {
                    newFiles.push({ name: args.nomeArquivo, location: args.destino });
                  }
                  return newFiles;
                });
                addLog(`J.A.R.V.I.S: Arquivo ${args.nomeArquivo} movido para ${args.destino}`);
                result = { status: 'sucesso', mensagem: 'Arquivo movido com sucesso.' };
              } else {
                addLog(`J.A.R.V.I.S: Acessando banco de dados global (Pesquisa Web)...`);
                result = { status: 'sucesso' };
              }
              return {
                id: call.id,
                name: call.name,
                response: result
              };
            });
            
            if (sessionRef.current) {
              sessionRef.current.sendToolResponse({ functionResponses: responses });
            }
          }
        }
      },
      onclose: () => {
            addLog("SYS: Conexão encerrada pelo servidor.");
            disconnectJarvis();
          },
          onerror: (err) => {
            addLog(`ERR: Falha crítica de conexão - ${err}`);
            disconnectJarvis();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err) {
      addLog(`ERR: Falha na inicialização - ${err}`);
      console.error(err);
    }
  };

  const disconnectJarvis = () => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    stopScreenShare();
    setIsConnected(false);
    setIsSpeaking(false);
    setAudioLevel(0);
    addLog("SYS: Sistemas offline.");
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnectJarvis();
    };
  }, []);

  return (
    <div className="min-h-screen flex flex-col items-center justify-between p-6 font-sans">
      
      {/* HEADER */}
      <header className="w-full flex justify-between items-start relative z-10">
        <div className="flex flex-col">
          <div className="flex items-center gap-3">
            <h1 className="text-5xl font-bold tracking-widest text-[#00f3ff] uppercase drop-shadow-[0_0_15px_rgba(0,243,255,0.8)]">
              J.A.R.V.I.S.
            </h1>
            <div className="px-2 py-0.5 border border-[#00f3ff]/50 bg-[#00f3ff]/10 text-[10px] font-mono rounded">MARK VII</div>
          </div>
          <span className="text-xs font-mono text-[#00f3ff] opacity-70 tracking-widest mt-1">
            JUST A RATHER VERY INTELLIGENT SYSTEM // PROTOCOL: OMEGA
          </span>
        </div>
        
        <div className="flex gap-4">
          <div className="hud-panel p-3 flex flex-col items-end">
            <span className="text-[10px] font-mono opacity-50">STATUS DA REDE</span>
            <div className="flex items-center gap-2 mt-1">
              <Wifi size={14} className={isConnected ? "text-[#00f3ff]" : "text-red-500"} />
              <span className="text-sm font-mono">{isConnected ? "CONECTADO" : "OFFLINE"}</span>
            </div>
          </div>
          <div className="hud-panel p-3 flex flex-col items-end">
            <span className="text-[10px] font-mono opacity-50">NÚCLEO DE PROCESSAMENTO</span>
            <div className="flex items-center gap-2 mt-1">
              <Cpu size={14} className="text-[#00f3ff]" />
              <span className="text-sm font-mono">{isConnected ? "ATIVO" : "STANDBY"}</span>
            </div>
          </div>
        </div>
      </header>

      {/* MAIN HUD AREA */}
      <main className="flex-1 w-full flex items-center justify-center relative my-8">
        
    {/* Left Panel - Logs & Calendar */}
    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-80 h-[32rem] flex flex-col gap-4 hidden lg:flex">
      <div className="hud-panel p-4 flex flex-col flex-1 overflow-hidden">
        <div className="hud-panel-glow"></div>
        <div className="flex items-center justify-between border-b border-[#00f3ff]/30 pb-2 mb-2">
          <div className="flex items-center gap-2">
            <Database size={16} />
            <h2 className="font-bold tracking-wider text-sm">REGISTRO DE SISTEMA</h2>
          </div>
          <span className="text-[9px] font-mono opacity-50">SYS.LOG.01</span>
        </div>
        <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed flex flex-col gap-1">
          {logs.map((log, i) => (
            <div key={i} className={`${log.startsWith('ERR') ? 'text-red-400' : log.startsWith('J.A.R.V.I.S') ? 'text-white' : 'text-[#00f3ff]/70'}`}>
              {log}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>

      <div className="hud-panel p-4 flex flex-col h-48">
        <div className="flex items-center gap-2 border-b border-[#00f3ff]/30 pb-2 mb-2">
          <Calendar size={16} />
          <h2 className="font-bold tracking-wider text-sm">AGENDA VIRTUAL</h2>
        </div>
        <div className="flex-1 overflow-y-auto font-mono text-xs flex flex-col gap-2">
          {meetings.map((m, i) => (
            <div key={i} className="flex justify-between items-center bg-[#00f3ff]/5 p-2 border border-[#00f3ff]/20">
              <span className="text-[#00f3ff] truncate mr-2">{m.title}</span>
              <span className="text-white opacity-80 whitespace-nowrap">{m.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>

    {/* Center - Arc Reactor */}
    <div className="relative flex items-center justify-center">
      <div className={`arc-reactor ${isConnected ? 'active' : 'opacity-30 grayscale'}`}>
        <div className="arc-ring arc-ring-1"></div>
        <div className="arc-ring arc-ring-2"></div>
        <div className="arc-ring arc-ring-3"></div>
        
        {/* Core that reacts to speaking and audio input */}
        <motion.div 
          className={`arc-core ${isSpeaking ? 'speaking' : ''}`}
          animate={{
            scale: isConnected ? 1 + (audioLevel * 2) : 1,
            opacity: isConnected ? 0.8 + (audioLevel * 2) : 0.5
          }}
          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        />
      </div>
      
      {/* Status Text under reactor */}
      <div className="absolute -bottom-16 text-center">
        <div className="font-mono text-xs tracking-[0.3em] opacity-70">
          {isSpeaking ? "TRANSMITINDO..." : isConnected ? "AGUARDANDO COMANDO..." : "SISTEMA DESLIGADO"}
        </div>
      </div>
    </div>

    {/* Right Panel - Modules & Files */}
    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-80 h-[32rem] flex flex-col gap-4 hidden lg:flex">
      <div className="hud-panel p-4 flex flex-col">
        <div className="hud-panel-glow" style={{ animationDelay: '2s' }}></div>
        <div className="flex items-center justify-between border-b border-[#00f3ff]/30 pb-2 mb-3">
          <div className="flex items-center gap-2">
            <Activity size={16} />
            <h2 className="font-bold tracking-wider text-sm">MÓDULOS ATIVOS</h2>
          </div>
          <span className="text-[9px] font-mono opacity-50">CORE.MOD.02</span>
        </div>
        
        <div className="flex flex-col gap-3">
          <div className="flex justify-between items-center">
            <span className="font-mono text-xs">RECONHECIMENTO DE VOZ</span>
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[#00f3ff] shadow-[0_0_5px_#00f3ff]' : 'bg-red-500'}`} />
          </div>
          <div className="flex justify-between items-center">
            <span className="font-mono text-xs">SÍNTESE DE FALA</span>
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[#00f3ff] shadow-[0_0_5px_#00f3ff]' : 'bg-red-500'}`} />
          </div>
          <div className="flex justify-between items-center">
            <span className="font-mono text-xs">ACESSO À REDE GLOBAL</span>
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-[#00f3ff] shadow-[0_0_5px_#00f3ff]' : 'bg-red-500'}`} />
          </div>
          <div className="flex justify-between items-center">
            <span className="font-mono text-xs">INTERFACE VISUAL (TELA)</span>
            <div className={`w-2 h-2 rounded-full ${isScreenSharing ? 'bg-[#00f3ff] shadow-[0_0_5px_#00f3ff]' : 'bg-red-500'}`} />
          </div>
        </div>
      </div>

      <div className="hud-panel p-4 flex flex-col flex-1 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-[#00f3ff]/30 pb-2 mb-2">
          <FolderSync size={16} />
          <h2 className="font-bold tracking-wider text-sm">SISTEMA DE ARQUIVOS</h2>
        </div>
        <div className="flex-1 overflow-y-auto font-mono text-xs flex flex-col gap-2">
          {files.map((f, i) => (
            <div key={i} className="flex flex-col bg-[#00f3ff]/5 p-2 border border-[#00f3ff]/20">
              <span className="text-white font-bold truncate">{f.name}</span>
              <span className="text-[#00f3ff] opacity-70 text-[10px] truncate">Dir: {f.location}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
      </main>

      {/* FOOTER CONTROLS */}
      <footer className="w-full max-w-2xl flex justify-center gap-6 mt-8">
        <button
          onClick={connectJarvis}
          className={`hud-panel px-8 py-4 flex items-center gap-3 transition-all duration-300 hover:bg-[#00f3ff]/10 ${isConnected ? 'border-[#00f3ff] shadow-[0_0_15px_rgba(0,243,255,0.3)]' : 'border-gray-600 text-gray-400'}`}
        >
          <Power size={24} className={isConnected ? 'text-[#00f3ff]' : ''} />
          <span className="font-bold tracking-widest text-lg">
            {isConnected ? 'DESATIVAR SISTEMA' : 'INICIAR J.A.R.V.I.S.'}
          </span>
        </button>

        <button
          onClick={toggleScreenShare}
          disabled={!isConnected}
          className={`hud-panel px-6 py-4 flex items-center gap-3 transition-all duration-300 ${!isConnected ? 'opacity-50 cursor-not-allowed border-gray-600 text-gray-500' : isScreenSharing ? 'border-[#00f3ff] shadow-[0_0_15px_rgba(0,243,255,0.3)] bg-[#00f3ff]/10' : 'hover:bg-[#00f3ff]/10'}`}
        >
          {isScreenSharing ? <Monitor size={20} className="text-[#00f3ff]" /> : <MonitorOff size={20} />}
          <span className="font-bold tracking-widest">
            {isScreenSharing ? 'PARAR VISÃO' : 'COMPARTILHAR TELA'}
          </span>
        </button>
      </footer>
    </div>
  );
}
