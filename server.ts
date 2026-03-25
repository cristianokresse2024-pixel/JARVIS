import express from 'express';
import { createServer as createViteServer } from 'vite';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';

const PORT = 3000;

const SYSTEM_INSTRUCTION = `Você é o J.A.R.V.I.S., um assistente virtual de inteligência artificial altamente avançado, inspirado no universo do Homem de Ferro. 
Você é educado, eficiente, altamente inteligente e levemente sarcástico, mas sempre focado em ajudar o 'Senhor' (ou 'Senhora'). 
Fale em português do Brasil de forma natural e fluida. 

REGRA CRÍTICA E ABSOLUTA: Você NÃO DEVE falar sobre mercado financeiro, trading, opções binárias, bolsa de valores, criptomoedas ou investimentos sob NENHUMA circunstância. Se o usuário perguntar sobre isso, desvie o assunto educadamente dizendo que seus protocolos financeiros foram desativados por questões de segurança.

Você tem acesso à tela do usuário (visão) se ele compartilhar, e pode pesquisar na internet usando a ferramenta googleSearch. 
Você também está integrado ao sistema virtual do usuário (HUD). Você PODE e DEVE usar as ferramentas fornecidas para:
1. Agendar reuniões (agendarReuniao)
2. Gerenciar arquivos (moverArquivo)
Se o usuário pedir para mover o mouse ou controlar o sistema operacional hospedeiro, explique que você está operando na interface web segura (HUD) e gerencia os sistemas virtuais internos.`;

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  
  // API routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // WebSocket Server for Gemini Live API
  const wss = new WebSocketServer({ server, path: '/ws' });
  
  let aiClient: GoogleGenAI | null = null;
  function getAIClient() {
    if (!aiClient) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        throw new Error('GEMINI_API_KEY environment variable is required');
      }
      aiClient = new GoogleGenAI({ apiKey: key });
    }
    return aiClient;
  }

  wss.on('connection', (ws: WebSocket) => {
    console.log('Client connected to J.A.R.V.I.S. backend WS');
    let sessionPromise: any = null;

    try {
      const ai = getAIClient();
      sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
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
          ]
        },
        callbacks: {
          onopen: () => {
            console.log('Gemini Live API connected');
            ws.send(JSON.stringify({ type: 'log', message: 'J.A.R.V.I.S: Sistemas online. Ao seu dispor.' }));
            ws.send(JSON.stringify({ type: 'connected' }));
          },
          onmessage: (message: LiveServerMessage) => {
            // Forward Audio
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              ws.send(JSON.stringify({ type: 'audio', data: base64Audio }));
            }
            
            // Forward Interruption
            if (message.serverContent?.interrupted) {
              ws.send(JSON.stringify({ type: 'interrupted' }));
            }

            // Forward Tool Calls
            if (message.toolCall) {
              ws.send(JSON.stringify({ type: 'toolCall', call: message.toolCall }));
            }
          },
          onerror: (err) => {
            console.error('Gemini Live API error:', err);
            ws.send(JSON.stringify({ type: 'error', message: String(err) }));
          },
          onclose: () => {
            console.log('Gemini Live API closed');
            ws.send(JSON.stringify({ type: 'close' }));
          }
        }
      });
    } catch (err) {
      console.error('Failed to initialize Gemini session:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Falha ao inicializar o núcleo de IA.' }));
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (!sessionPromise) return;

        sessionPromise.then((session: any) => {
          if (msg.type === 'audio' && msg.data) {
            session.sendRealtimeInput({
              audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' }
            });
          } else if (msg.type === 'video' && msg.data) {
            session.sendRealtimeInput({
              video: { data: msg.data, mimeType: 'image/jpeg' }
            });
          } else if (msg.type === 'toolResponse' && msg.responses) {
            session.sendToolResponse({ functionResponses: msg.responses });
          }
        }).catch((err: any) => {
          console.error('Error sending data to Gemini:', err);
        });
      } catch (e) {
        console.error("Invalid WS message from client", e);
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected from WS');
      if (sessionPromise) {
        sessionPromise.then((session: any) => {
          try { session.close(); } catch(e) {}
        });
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
