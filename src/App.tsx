import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import "./App.css";

declare global {
  interface HTMLVideoElement {
    captureStream(): MediaStream;
  }
}

type Role = "host" | "viewer";

type ConnectionStatus =
  | "connecting"
  | "waiting"
  | "connecting-peer"
  | "connected"
  | "disconnected"
  | "host-left";

type PlaybackState = {
  type: "playback-state";
  position: number;
  playing: boolean;
  duration: number;
};

type PendingIceCandidate = {
  sender: string;
  candidate: RTCIceCandidateInit;
};

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

async function getIceServers(
  serverUrl: string,
): Promise<RTCIceServer[]> {
  const fallback: RTCIceServer[] = [
    {
      urls: [
        "stun:stun.cloudflare.com:3478",
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
      ],
    },
  ];

  try {
    const response = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/turn-credentials`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
      },
    );

    if (!response.ok) {
      throw new Error(`TURN endpoint returned HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
      iceServers?: RTCIceServer[];
    };

    if (!data.iceServers?.length) {
      throw new Error("TURN endpoint returned no ICE servers");
    }

    return data.iceServers;
  } catch (error) {
    console.warn("Unable to load Cloudflare TURN credentials:", error);
    return fallback;
  }
}

function App() {
  const socketRef = useRef<Socket | null>(null);

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);

  const remoteStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoStreamRef = useRef<MediaStream | null>(null);

  const viewerIdRef = useRef<string | null>(null);
  const videoUrlRef = useRef<string | null>(null);

  const playbackIntervalRef = useRef<number | null>(null);
  const mediaUpdateIdRef = useRef(0);

  const pendingIceCandidatesRef = useRef<PendingIceCandidate[]>([]);
  const remotePeerIdRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const iceServersPromiseRef = useRef<Promise<RTCIceServer[]> | null>(null);

  const [connected, setConnected] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [roomId, setRoomId] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [status, setStatus] = useState("Connecting...");
  const [videoName, setVideoName] = useState("");

  const [remotePosition, setRemotePosition] = useState(0);
  const [remoteDuration, setRemoteDuration] = useState(0);
  const [remotePlaying, setRemotePlaying] = useState(false);
  const [remotePlaybackBlocked, setRemotePlaybackBlocked] = useState(false);
  const [remoteUpdatedAt, setRemoteUpdatedAt] = useState(0);

  const [volume, setVolume] = useState(1);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [, setConnectionStatus] =
    useState<ConnectionStatus>("connecting");

  function log(text: string) {
    console.log(text);
    setLogs((previous) => [...previous.slice(-99), text]);
  }

  useEffect(() => {
    const serverUrl =
      import.meta.env.VITE_SERVER_URL || window.location.origin;

    const socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      reconnection: true,
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setConnectionStatus("connecting");
      setStatus("Connected to server");
      log(`Socket connected: ${socket.id}`);
    });

    socket.on("connect_error", (error) => {
      setConnected(false);
      setStatus("Server connection failed");
      log(`Socket connection error: ${String(error)}`);
    });

    socket.on("disconnect", (reason) => {
      setConnected(false);
      setConnectionStatus("disconnected");
      setStatus("Disconnected");
      log(`Socket disconnected: ${reason}`);
    });

    socket.on("room-created", (data) => {
      setRole("host");
      setRoomId(data.roomId);
      setConnectionStatus("waiting");
      setStatus("Waiting for viewer...");
      log(`Room created: ${data.roomId}`);
    });

    socket.on("room-joined", (data) => {
      setRole("viewer");
      setRoomId(data.roomId);
      setConnectionStatus("connecting-peer");
      setStatus("Connecting to host...");
      log(`Joined room: ${data.roomId}`);
    });

    socket.on("room-error", (data) => {
      log(`ERROR: ${data.message}`);
      setStatus(data.message);
    });

    socket.on("viewer-joined", async (data) => {
      viewerIdRef.current = data.viewerId;
      remotePeerIdRef.current = data.viewerId;

      log(`Viewer joined: ${data.viewerId}`);

      if (localVideoRef.current?.src) {
        try {
          await startWebRTC(data.viewerId);
        } catch (error) {
          log(`Failed to start WebRTC: ${String(error)}`);
          setStatus("Unable to start video connection");
        }
      } else {
        log("Viewer joined. Waiting for host video.");
        setStatus("Viewer joined. Choose a video.");
      }
    });

    socket.on("webrtc-offer", async (data) => {
      log(`Received WebRTC offer from ${data.sender}`);

      try {
        await handleOffer(data.sender, data.offer);
      } catch (error) {
        log(`Offer handling failed: ${String(error)}`);
        setStatus("Failed to connect to host");
      }
    });

    socket.on("webrtc-answer", async (data) => {
      const peer = peerConnectionRef.current;

      if (!peer) {
        log("Received answer but peer connection does not exist.");
        return;
      }

      try {
        await peer.setRemoteDescription(data.answer);
        await flushPendingIceCandidates(peer);
        log("Remote answer applied");

        if (peer.connectionState === "connecting") {
          setStatus(
            role === "host"
              ? "Connecting to viewer..."
              : "Connecting to host...",
          );
        }
      } catch (error) {
        log(`Answer handling failed: ${String(error)}`);
      }
    });

    socket.on("webrtc-ice-candidate", async (data) => {
      await handleRemoteIceCandidate(
        data.sender,
        data.candidate,
      );
    });

    socket.on("viewer-left", (data) => {
      log(`Viewer left: ${data.viewerId}`);

      if (viewerIdRef.current === data.viewerId) {
        viewerIdRef.current = null;
        remotePeerIdRef.current = null;
        cleanupPeerConnection();
        setConnectionStatus("waiting");
        setStatus("Waiting for viewer...");
      }
    });

    socket.on("host-left", () => {
      cleanupPeerConnection();
      setConnectionStatus("host-left");
      setStatus("Host left the room");
      setRole(null);
      setRoomId("");
      log("Host left room");
    });

    return () => {
      cleanupPeerConnection();
      socket.disconnect();

      if (videoUrlRef.current) {
        URL.revokeObjectURL(videoUrlRef.current);
        videoUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (role !== "host") return;

    const video = localVideoRef.current;
    if (!video) return;

    const handlePlaybackChange = () => sendPlaybackState();
    const handleEnded = () => {
      log("Host video ended.");
      sendPlaybackState();
    };

    video.addEventListener("play", handlePlaybackChange);
    video.addEventListener("pause", handlePlaybackChange);
    video.addEventListener("seeked", handlePlaybackChange);
    video.addEventListener("loadedmetadata", handlePlaybackChange);
    video.addEventListener("ended", handleEnded);

    return () => {
      video.removeEventListener("play", handlePlaybackChange);
      video.removeEventListener("pause", handlePlaybackChange);
      video.removeEventListener("seeked", handlePlaybackChange);
      video.removeEventListener("loadedmetadata", handlePlaybackChange);
      video.removeEventListener("ended", handleEnded);
    };
  }, [role]);

  useEffect(() => {
    if (role !== "viewer" || !remotePlaying) {
      setDisplayPosition(remotePosition);
      return;
    }

    const interval = window.setInterval(() => {
      const elapsed =
        (performance.now() - remoteUpdatedAt) / 1000;

      const position = remotePosition + elapsed;

      setDisplayPosition(
        Math.min(
          position,
          remoteDuration || position,
        ),
      );
    }, 100);

    return () => window.clearInterval(interval);
  }, [
    role,
    remotePlaying,
    remotePosition,
    remoteDuration,
    remoteUpdatedAt,
  ]);

  const [displayPosition, setDisplayPosition] = useState(0);

  async function createPeerConnection(remoteId: string): Promise<RTCPeerConnection> {
    if (peerConnectionRef.current) {
      cleanupPeerConnection();
    }

    remotePeerIdRef.current = remoteId;

    const serverUrl =
      import.meta.env.VITE_SERVER_URL || window.location.origin;

    const iceServersPromise =
      iceServersPromiseRef.current ??
      (iceServersPromiseRef.current = getIceServers(serverUrl));

    return iceServersPromise.then((iceServers) => {
      log(`ICE servers loaded: ${iceServers.length}`);

      const peer = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 10,
        bundlePolicy: "max-bundle",
        rtcpMuxPolicy: "require",
      });

      peerConnectionRef.current = peer;

      peer.onicecandidate = (event) => {
        if (!event.candidate) return;

        socketRef.current?.emit("webrtc-ice-candidate", {
          target: remoteId,
          candidate: event.candidate.toJSON(),
        });
      };

      peer.onicegatheringstatechange = () => {
        log(`ICE gathering: ${peer.iceGatheringState}`);
      };

      peer.oniceconnectionstatechange = () => {
        log(`ICE connection: ${peer.iceConnectionState}`);

        if (peer.iceConnectionState === "checking") {
          setStatus(
            role === "host"
              ? "Connecting to viewer..."
              : "Connecting to host...",
          );
        }

        if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
          setConnectionStatus("connected");
          setStatus(
            role === "host"
              ? "Viewer connected"
              : "Connected to host",
          );
        }

        if (peer.iceConnectionState === "failed") {
          setStatus("ICE failed. Retrying connection...");
          scheduleIceRestart();
        }
      };

      peer.onconnectionstatechange = () => {
        const state = peer.connectionState;
        log(`WebRTC connection: ${state}`);

        if (state === "connected") {
          setConnectionStatus("connected");
          setStatus(
            role === "host"
              ? "Viewer connected"
              : "Connected to host",
          );
        }

        if (state === "disconnected") {
          setConnectionStatus("disconnected");
          setStatus("Connection interrupted...");
        }

        if (state === "failed") {
          setConnectionStatus("disconnected");
          setStatus("Connection failed");
          scheduleIceRestart();
        }
      };

      peer.ontrack = (event) => {
        log(
          `Remote track received: ${event.track.kind}, streams=${event.streams.length}`,
        );

        const stream =
          remoteStreamRef.current ?? new MediaStream();

        if (event.streams.length > 0) {
          for (const incomingStream of event.streams) {
            for (const track of incomingStream.getTracks()) {
              if (!stream.getTracks().includes(track)) {
                stream.addTrack(track);
              }
            }
          }
        } else if (!stream.getTracks().includes(event.track)) {
          stream.addTrack(event.track);
        }

        remoteStreamRef.current = stream;

        const remoteVideo = remoteVideoRef.current;

        if (!remoteVideo) {
          log("Remote video element is not mounted yet.");
          return;
        }

        remoteVideo.srcObject = stream;
        remoteVideo.volume = volume;

        event.track.onended = () => {
          log(`Remote track ended: ${event.track.kind}`);
        };

        void remoteVideo.play()
          .then(() => {
            setRemotePlaybackBlocked(false);
            log("Remote video playback started");
          })
          .catch((error: unknown) => {
            setRemotePlaybackBlocked(true);
            log(`Remote autoplay blocked: ${String(error)}`);
          });

        log(`Remote stream attached. tracks=${stream.getTracks().length}`);
      };

      peer.ondatachannel = (event) => {
        setupDataChannel(event.channel);
      };

      return peer;
    });
  }

  async function flushPendingIceCandidates(
    peer: RTCPeerConnection,
  ) {
    if (!peer.remoteDescription) return;

    const currentPeerId = remotePeerIdRef.current;

    const candidates =
      pendingIceCandidatesRef.current.filter(
        (item) => !currentPeerId || item.sender === currentPeerId,
      );

    pendingIceCandidatesRef.current =
      pendingIceCandidatesRef.current.filter(
        (item) =>
          currentPeerId && item.sender !== currentPeerId,
      );

    for (const item of candidates) {
      try {
        await peer.addIceCandidate(item.candidate);
        log("Queued ICE candidate applied");
      } catch (error) {
        log(`Queued ICE candidate failed: ${String(error)}`);
      }
    }
  }

  async function handleRemoteIceCandidate(
    sender: string,
    candidate: RTCIceCandidateInit,
  ) {
    const peer = peerConnectionRef.current;

    if (
      !peer ||
      !peer.remoteDescription ||
      remotePeerIdRef.current !== sender
    ) {
      pendingIceCandidatesRef.current.push({
        sender,
        candidate,
      });
      log("ICE candidate queued");
      return;
    }

    try {
      await peer.addIceCandidate(candidate);
    } catch (error) {
      log(`ICE candidate error: ${String(error)}`);
    }
  }

  function scheduleIceRestart() {
    if (reconnectTimerRef.current) return;

    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;

      const peer = peerConnectionRef.current;
      const remoteId = remotePeerIdRef.current;

      if (!peer || !remoteId) return;

      if (role === "host" && localVideoRef.current?.src) {
        void restartHostConnection(remoteId);
      }
    }, 1500);
  }

  async function restartHostConnection(remoteId: string) {
    const video = localVideoRef.current;

    if (!video?.src) return;

    try {
      cleanupPeerConnection();

      await waitForVideoReady(video);

      if (viewerIdRef.current !== remoteId) return;

      await startWebRTC(remoteId);
      log("WebRTC connection restarted");
    } catch (error) {
      log(`WebRTC restart failed: ${String(error)}`);
    }
  }

  function setupDataChannel(channel: RTCDataChannel) {
    dataChannelRef.current = channel;

    channel.onopen = () => {
      log("DataChannel OPEN");

      if (role === "host") {
        startPlaybackSync();
      }

      if (role === "viewer") {
        sendPlaybackStateRequest();
      }
    };

    channel.onclose = () => {
      log("DataChannel CLOSED");
    };

    channel.onerror = (error) => {
      log(`DataChannel error: ${String(error)}`);
    };

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "playback-state") {
          setRemotePosition(data.position ?? 0);
          setRemoteDuration(data.duration ?? 0);
          setRemotePlaying(data.playing ?? false);
          setRemoteUpdatedAt(performance.now());

          return;
        }

        if (data.type === "playback-state-request") {
          sendPlaybackState();
          return;
        }

        setMessages((previous) => [
          ...previous,
          `Remote: ${event.data}`,
        ]);
      } catch {
        setMessages((previous) => [
          ...previous,
          `Remote: ${event.data}`,
        ]);
      }
    };
  }

  function sendPlaybackState() {
    const channel = dataChannelRef.current;
    const video = localVideoRef.current;

    if (
      role !== "host" ||
      !channel ||
      channel.readyState !== "open" ||
      !video?.src
    ) {
      return;
    }

    const state: PlaybackState = {
      type: "playback-state",
      position: video.currentTime,
      playing: !video.paused,
      duration: Number.isFinite(video.duration)
        ? video.duration
        : 0,
    };

    channel.send(JSON.stringify(state));
  }

  function sendPlaybackStateRequest() {
    const channel = dataChannelRef.current;

    if (channel?.readyState === "open") {
      channel.send(
        JSON.stringify({
          type: "playback-state-request",
        }),
      );
    }
  }

  function startPlaybackSync() {
    if (playbackIntervalRef.current) {
      window.clearInterval(playbackIntervalRef.current);
    }

    sendPlaybackState();

    playbackIntervalRef.current = window.setInterval(() => {
      sendPlaybackState();
    }, 500);
  }

  async function attachVideoToPeer(
    peer: RTCPeerConnection,
    video: HTMLVideoElement,
  ): Promise<boolean> {
    if (!video.captureStream) {
      throw new Error(
        "captureStream() is not supported by this browser.",
      );
    }

    const stream = video.captureStream();
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    if (!videoTrack) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("No video track available from captureStream().");
    }

    if ("contentHint" in videoTrack) {
      videoTrack.contentHint = "detail";
    }

    const videoSender = peer
      .getSenders()
      .find(
        (sender) =>
          sender.track?.kind === "video",
      );

    const audioSender = peer
      .getSenders()
      .find(
        (sender) =>
          sender.track?.kind === "audio",
      );

    let needsNegotiation = false;

    if (videoSender) {
      await videoSender.replaceTrack(videoTrack);
    } else {
      peer.addTrack(videoTrack, stream);
      needsNegotiation = true;
    }

    if (audioTrack) {
      if (audioSender) {
        await audioSender.replaceTrack(audioTrack);
      } else {
        peer.addTrack(audioTrack, stream);
        needsNegotiation = true;
      }
    }

    const previousStream = localVideoStreamRef.current;
    localVideoStreamRef.current = stream;

    if (previousStream && previousStream !== stream) {
      previousStream.getTracks().forEach((track) => {
        if (
          !localStreamRef.current
            ?.getTracks()
            .includes(track)
        ) {
          track.stop();
        }
      });
    }

    if (!localStreamRef.current) {
      localStreamRef.current = stream;
    }

    log(
      `Capture stream attached: video=${Boolean(
        videoTrack,
      )}, audio=${Boolean(audioTrack)}, renegotiation=${needsNegotiation}`,
    );

    return needsNegotiation;
  }

  async function startWebRTC(
    viewerId: string,
    expectedUpdateId?: number,
  ) {
    const video = localVideoRef.current;

    if (!video?.src) {
      log("No host video selected.");
      return;
    }

    await waitForVideoReady(video);

    if (
      expectedUpdateId !== undefined &&
      expectedUpdateId !== mediaUpdateIdRef.current
    ) {
      return;
    }

    let peer = peerConnectionRef.current;

    if (!peer) {
      peer = await createPeerConnection(viewerId);

      const channel =
        peer.createDataChannel("watch-party");

      setupDataChannel(channel);
    }

    const needsNegotiation =
      await attachVideoToPeer(peer, video);

    await configureVideoSender(peer);

    if (!needsNegotiation) {
      log(
        "Existing WebRTC senders reused; video track replaced without renegotiation.",
      );
      return;
    }

    const offer = await peer.createOffer({
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
    });

    await peer.setLocalDescription(offer);

    socketRef.current?.emit("webrtc-offer", {
      target: viewerId,
      offer: peer.localDescription,
    });

    log("WebRTC offer sent");
  }

  async function handleOffer(
    senderId: string,
    offer: RTCSessionDescriptionInit,
  ) {
    let peer = peerConnectionRef.current;

    if (!peer || remotePeerIdRef.current !== senderId) {
      peer = await createPeerConnection(senderId);
    }

    if (peer.signalingState !== "stable") {
      log(
        `Ignoring offer because signaling state is ${peer.signalingState}`,
      );
      return;
    }

    await peer.setRemoteDescription(offer);
    await flushPendingIceCandidates(peer);

    const answer = await peer.createAnswer();

    await peer.setLocalDescription(answer);

    socketRef.current?.emit("webrtc-answer", {
      target: senderId,
      answer: peer.localDescription,
    });

    log("WebRTC answer sent");
  }

  function createRoom() {
    socketRef.current?.emit("create-room");
  }

  function joinRoom() {
    const id = roomInput.trim().toUpperCase();

    if (!id) return;

    socketRef.current?.emit("join-room", {
      roomId: id,
    });
  }

  async function handleVideoChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];

    if (!file || role !== "host") return;

    const video = localVideoRef.current;
    if (!video) return;

    const updateId = ++mediaUpdateIdRef.current;

    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
    }

    const url = URL.createObjectURL(file);

    videoUrlRef.current = url;
    video.src = url;
    video.load();

    setVideoName(file.name);

    log(`Selected: ${file.name}`);

    if (!viewerIdRef.current) return;

    await waitForVideoReady(video);

    if (updateId !== mediaUpdateIdRef.current) return;

    try {
      await startWebRTC(
        viewerIdRef.current,
        updateId,
      );
    } catch (error) {
      log(`Video connection failed: ${String(error)}`);
      setStatus("Failed to send video to viewer");
    }
  }

  function waitForVideoReady(
    video: HTMLVideoElement,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (
        video.readyState >=
        HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        resolve();
        return;
      }

      const timeout = window.setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "Video did not become ready in time.",
          ),
        );
      }, 15000);

      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener(
          "canplay",
          handleReady,
        );
        video.removeEventListener(
          "loadeddata",
          handleReady,
        );
        video.removeEventListener(
          "error",
          handleError,
        );
      };

      const handleReady = () => {
        cleanup();
        resolve();
      };

      const handleError = () => {
        cleanup();
        reject(new Error("Unable to load selected video."));
      };

      video.addEventListener(
        "canplay",
        handleReady,
        { once: true },
      );
      video.addEventListener(
        "loadeddata",
        handleReady,
        { once: true },
      );
      video.addEventListener(
        "error",
        handleError,
        { once: true },
      );
    });
  }

  async function configureVideoSender(
    peer: RTCPeerConnection,
  ) {
    const sender = peer
      .getSenders()
      .find(
        (item) =>
          item.track?.kind === "video",
      );

    if (!sender) return;

    try {
      const parameters = sender.getParameters();

      if (!parameters.encodings) {
        parameters.encodings = [{}];
      }

      parameters.encodings[0] = {
        ...parameters.encodings[0],
        maxBitrate: 8_000_000,
        maxFramerate: 30,
      };

      await sender.setParameters(parameters);

      log("Video encoder configured");
    } catch (error) {
      // Some mobile/browser combinations reject codec parameter
      // changes. The WebRTC connection itself can still work.
      log(
        `Video encoder configuration skipped: ${String(error)}`,
      );
    }
  }

  function sendMessage() {
    const channel = dataChannelRef.current;

    if (
      !channel ||
      channel.readyState !== "open" ||
      !message.trim()
    ) {
      return;
    }

    channel.send(message);

    setMessages((previous) => [
      ...previous,
      `You: ${message}`,
    ]);

    setMessage("");
  }

  function toggleFullscreen() {
    const video = remoteVideoRef.current;

    if (!video) return;

    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }

    void video.requestFullscreen?.();
  }

  function playRemoteVideo() {
    const video = remoteVideoRef.current;

    if (!video) return;

    void video
      .play()
      .then(() => {
        setRemotePlaybackBlocked(false);
      })
      .catch((error: unknown) => {
        log(
          `Unable to play remote video: ${String(error)}`,
        );
      });
  }

  function handleVolumeChange(value: number) {
    setVolume(value);

    if (remoteVideoRef.current) {
      remoteVideoRef.current.volume = value;
    }
  }

  function cleanupPeerConnection() {
    if (playbackIntervalRef.current) {
      window.clearInterval(
        playbackIntervalRef.current,
      );
      playbackIntervalRef.current = null;
    }

    if (reconnectTimerRef.current) {
      window.clearTimeout(
        reconnectTimerRef.current,
      );
      reconnectTimerRef.current = null;
    }

    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    const streamsToStop = new Set(
      [
        localStreamRef.current,
        localVideoStreamRef.current,
      ].filter(
        (stream): stream is MediaStream =>
          Boolean(stream),
      ),
    );

    streamsToStop.forEach((stream) => {
      stream.getTracks().forEach((track) => {
        track.stop();
      });
    });

    localStreamRef.current = null;
    localVideoStreamRef.current = null;

    if (remoteVideoRef.current) {
      remoteVideoRef.current.pause();
      remoteVideoRef.current.srcObject = null;
    }

    remoteStreamRef.current = null;
    pendingIceCandidatesRef.current = [];
  }

  function leaveRoom() {
    cleanupPeerConnection();

    viewerIdRef.current = null;
    remotePeerIdRef.current = null;

    socketRef.current?.emit("leave-room");

    setRole(null);
    setRoomId("");
    setRoomInput("");
    setVideoName("");

    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = null;
    }

    setRemotePosition(0);
    setRemoteDuration(0);
    setRemotePlaying(false);
    setDisplayPosition(0);
    setRemotePlaybackBlocked(false);

    setConnectionStatus("connecting");
    setStatus("Connected");
  }

  if (!role) {
    return (
      <div className="min-h-screen bg-slate-950 text-white">
        <div className="mx-auto flex min-h-screen w-full max-w-5xl items-center justify-center px-4 py-8 sm:px-6">
          <div className="grid w-full gap-8 md:grid-cols-2 md:gap-10">
            <div className="flex flex-col justify-center">
              <div className="mb-4 inline-flex w-fit rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-300">
                Watch Party
              </div>

              <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
                Watch together,
                <br />
                wherever you are.
              </h1>

              <p className="mt-4 max-w-lg text-base leading-relaxed text-slate-400 sm:mt-5 sm:text-lg">
                Bagikan film yang ada di perangkatmu
                dan tonton bersama teman secara langsung.
                File video tetap berada di perangkat Host.
              </p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-2xl sm:p-7">
              <h2 className="text-xl font-semibold sm:text-2xl">
                Start watching
              </h2>

              <p className="mt-2 text-sm text-slate-400">
                Buat room baru atau masuk menggunakan
                kode room.
              </p>

              <button
                onClick={createRoom}
                disabled={!connected}
                className="mt-6 w-full rounded-xl bg-white px-5 py-3.5 font-semibold text-slate-950 transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Create Room
              </button>

              <div className="my-5 flex items-center gap-3 text-xs text-slate-500">
                <div className="h-px flex-1 bg-white/10" />
                OR
                <div className="h-px flex-1 bg-white/10" />
              </div>

              <input
                value={roomInput}
                onChange={(event) =>
                  setRoomInput(event.target.value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    joinRoom();
                  }
                }}
                placeholder="Enter room code"
                autoCapitalize="characters"
                className="w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-white/30"
              />

              <button
                onClick={joinRoom}
                disabled={
                  !connected ||
                  !roomInput.trim()
                }
                className="mt-3 w-full rounded-xl border border-white/10 bg-white/10 px-5 py-3.5 font-semibold transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Join Room
              </button>

              <div className="mt-5 text-center text-xs text-slate-500">
                {connected
                  ? "Connected to server"
                  : "Connecting..."}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="min-w-0 flex-1">
            <div className="truncate font-bold">
              Watch Party
            </div>

            <div className="truncate text-xs text-slate-500">
              {status}
            </div>
          </div>

          <div className="hidden rounded-lg bg-white/5 px-4 py-2 font-mono text-sm sm:block">
            {roomId}
          </div>

          <div className="rounded-lg bg-white/5 px-3 py-2 font-mono text-xs sm:hidden">
            {roomId}
          </div>

          <button
            onClick={leaveRoom}
            className="shrink-0 rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs font-medium text-red-300 transition hover:bg-red-400/20 sm:px-4 sm:text-sm"
          >
            Leave
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-8">
        {role === "host" && (
          <section className="mb-5 rounded-2xl border border-white/10 bg-white/5 p-4 sm:mb-8 sm:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="font-semibold">
                  Host controls
                </h2>

                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  Pilih film dari perangkatmu. Film tidak
                  di-upload ke server.
                </p>
              </div>

              <label className="w-full cursor-pointer rounded-xl bg-white px-5 py-3.5 text-center font-semibold text-slate-950 hover:bg-slate-200 sm:w-auto">
                Choose Video
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/*"
                  onChange={handleVideoChange}
                  className="hidden"
                />
              </label>
            </div>

            {videoName && (
              <div className="mt-4 overflow-hidden rounded-xl bg-black/20 px-4 py-3 text-sm text-slate-300">
                <span className="text-slate-500">
                  Playing:
                </span>
                <span className="ml-2 break-all font-medium text-white">
                  {videoName}
                </span>
              </div>
            )}
          </section>
        )}

        <div
          className={
            role === "host"
              ? "grid gap-5 lg:grid-cols-1"
              : "grid gap-5"
          }
        >
          {role === "host" && (
            <section>
              <div className="mb-3">
                <h2 className="text-lg font-semibold">
                  Your screen
                </h2>

                <p className="text-sm text-slate-500">
                  Kontrol playback dari sini.
                </p>
              </div>

              <div className="overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
                <video
                  ref={localVideoRef}
                  controls
                  playsInline
                  className="aspect-video max-h-[70vh] w-full bg-black object-contain"
                />
              </div>
            </section>
          )}

          {role === "viewer" && (
            <section>
              <div className="mb-3">
                <h2 className="text-lg font-semibold">
                  Now watching
                </h2>

                <p className="text-sm text-slate-500">
                  Playback mengikuti Host.
                </p>
              </div>

              <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black shadow-2xl">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  preload="auto"
                  onLoadedMetadata={() => {
                    log("Remote video metadata loaded");
                    void remoteVideoRef.current?.play()
                      .then(() =>
                        setRemotePlaybackBlocked(false),
                      )
                      .catch(() =>
                        setRemotePlaybackBlocked(true),
                      );
                  }}
                  onCanPlay={() => {
                    log("Remote video can play");
                  }}
                  onPlaying={() =>
                    setRemotePlaybackBlocked(false)
                  }
                  className="aspect-video max-h-[75vh] w-full bg-black object-contain"
                />

                {remotePlaybackBlocked && (
                  <button
                    onClick={playRemoteVideo}
                    className="absolute inset-0 flex items-center justify-center bg-black/60 px-6 text-center font-semibold text-white"
                  >
                    Tap to play the stream
                  </button>
                )}

                <div className="flex flex-wrap items-center gap-3 border-t border-white/10 bg-slate-900 px-3 py-3 sm:gap-4 sm:px-4">
                  <span className="min-w-[90px] font-mono text-xs text-slate-300 sm:text-sm">
                    {formatTime(displayPosition)} /{" "}
                    {formatTime(remoteDuration)}
                  </span>

                  <div className="order-last h-1 w-full overflow-hidden rounded-full bg-white/10 sm:order-none sm:min-w-24 sm:flex-1">
                    <div
                      className="h-full rounded-full bg-white"
                      style={{
                        width:
                          remoteDuration > 0
                            ? `${Math.min(
                                100,
                                (displayPosition /
                                  remoteDuration) *
                                  100,
                              )}%`
                            : "0%",
                      }}
                    />
                  </div>

                  <span className="text-xs text-slate-500">
                    {remotePlaying
                      ? "Playing"
                      : "Paused"}
                  </span>

                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    onChange={(event) =>
                      handleVolumeChange(
                        Number(event.target.value),
                      )
                    }
                    className="w-20 sm:w-24"
                    title="Volume"
                  />

                  <button
                    onClick={toggleFullscreen}
                    className="rounded-lg px-2 py-1 text-slate-300 hover:bg-white/10"
                    title="Fullscreen"
                  >
                    ⛶
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>

        <section className="mt-5 grid gap-5 lg:grid-cols-2 sm:mt-8">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5">
            <h2 className="font-semibold">Chat</h2>

            <div className="mt-4 min-h-32 max-h-72 overflow-y-auto rounded-xl bg-black/20 p-4 text-sm text-slate-300">
              {messages.length === 0 ? (
                <span className="text-slate-600">
                  No messages yet.
                </span>
              ) : (
                messages.map((item, index) => (
                  <div
                    key={index}
                    className="break-words"
                  >
                    {item}
                  </div>
                ))
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <input
                value={message}
                onChange={(event) =>
                  setMessage(event.target.value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    sendMessage();
                  }
                }}
                placeholder="Type a message..."
                className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none placeholder:text-slate-600"
              />

              <button
                onClick={sendMessage}
                className="rounded-xl bg-white px-4 py-3 font-semibold text-slate-950 sm:px-5"
              >
                Send
              </button>
            </div>
          </div>

          <details className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-5">
            <summary className="cursor-pointer font-semibold text-slate-300">
              Developer Log
            </summary>

            <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/30 p-4 text-xs text-slate-500">
              {logs.join("\n")}
            </pre>
          </details>
        </section>
      </main>
    </div>
  );
}

export default App;
