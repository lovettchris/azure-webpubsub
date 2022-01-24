const cors = require("cors");
const express = require("express");

const Y = require("yjs");
const syncProtocol = require("y-protocols/dist/sync.cjs");
const awarenessProtocol = require("y-protocols/dist/awareness.cjs");

const encoding = require("lib0/dist/encoding.cjs");
const decoding = require("lib0/dist/decoding.cjs");
const map = require("lib0/dist/map.cjs");

const messageSync = 0;
const messageAwareness = 1;

const docs = new Map();

const send = (doc, conn, m) => {
  console.log(m);
};

const updateHandler = (update, origin, doc) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, messageSync);
  syncProtocol.writeUpdate(encoder, update);
  const message = encoding.toUint8Array(encoder);
  doc.conns.forEach((_, conn) => send(doc, conn, message));
};

class WSSharedDoc extends Y.Doc {
  conns: Map<string, ConnectionContext>;

  /**
   * @param {string} name
   */
  constructor(name) {
    super({ gc: true });
    this.name = name;
    /**
     * Maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
     * @type {Map<Object, Set<number>>}
     */
    this.conns = new Map();
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = new awarenessProtocol.Awareness(this);
    this.awareness.setLocalState(null);
    /**
     * @param {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} changes
     * @param {Object | null} conn Origin is the connection that made the change
     */
    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed);
      // broadcast awareness update
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients)
      );
      const buff = encoding.toUint8Array(encoder);
      this.conns.forEach((_, c) => {
        send(this, c, buff);
      });
    };
    this.awareness.on("update", awarenessChangeHandler);
    this.on("update", updateHandler);
  }
}

const doc = new WSSharedDoc("codestream");

import { WebPubSubServiceClient } from "@azure/web-pubsub";

import {
  ConnectRequest,
  ConnectResponseHandler,
  ConnectedRequest,
  DisconnectedRequest,
  UserEventRequest,
  UserEventResponseHandler,
  WebPubSubEventHandler,
  ConnectionContext,
} from "@azure/web-pubsub-express";
import { broadcastchannel } from "lib0";

const builder = require("./src/aad-express-middleware");

const aadJwtMiddleware = builder.build({
  tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
  audience: [
    "ee79ab73-0c3a-4e1e-b8a6-46f0e8753c8b", // dev
    "ac6517b5-4fe1-43de-af2d-ce0aa3cfd6d9", // prod
  ],
});

const hubName = "codestream";

const app = express();

enum UserState {
  Host = 0,
  Active,
  Inactive,
}

class GroupUser {
  connId: string;
  state: UserState;
  user: string;

  constructor(connId: string, user: string) {
    this.connId = connId;
    this.user = user;
    this.state = UserState.Active;
  }
}

function state2status(state: UserState) {
  switch (state) {
    case UserState.Host:
      return "host";
    case UserState.Active:
      return "online";
    case UserState.Inactive:
      return "offline";
  }
}

class GroupContext {
  users: { [key: string]: GroupUser };

  name: string;

  constructor(name: string) {
    this.name = name;
    this.users = {};
  }

  host(user: string) {
    let current: GroupUser;
    let currentHost: GroupUser;

    Object.entries(this.users).forEach(([k, v]) => {
      if (k == user) {
        current = v;
      }
      if (v.state == UserState.Host) {
        currentHost = v;
      }
    });

    if (currentHost == undefined || currentHost === current) {
      current.state = UserState.Host;
      return true;
    }
    return false;
  }

  offline(user: string, connId: string) {
    Object.entries(this.users).forEach(([k, v]) => {
      if (k == user && v.connId == connId) {
        v.state = UserState.Inactive;
      }
    });
  }

  toJSON() {
    let res = {
      type: "lobby",
      users: [],
    };

    for (let [k, v] of Object.entries(this.users)) {
      res.users.push({
        connectionId: v.connId,
        name: v.user,
        status: state2status(v.state),
      });
    }
    return res;
  }
}

let groupDict: { [key: string]: GroupContext } = {};
let connectionDict: { [key: string]: string } = {};

let defaultConnectionString =
  "Endpoint=https://code-stream.webpubsub.azure.com;AccessKey=BDSQB6iSxoHTtpCkGn+yNHA1UrGA6HIDeUYm3pCFzws=;Version=1.0;";

let connectionString =
  process.argv[2] ||
  process.env.WebPubSubConnectionString ||
  defaultConnectionString;

const ClaimTypeRole =
  "http://schemas.microsoft.com/ws/2008/06/identity/claims/role";
const ClaimTypeName =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier";

let client: WebPubSubServiceClient = new WebPubSubServiceClient(
  connectionString ?? "",
  hubName
);

function Arr2Buf(array: Uint8Array): ArrayBuffer {
  return array.buffer.slice(
    array.byteOffset,
    array.byteLength + array.byteOffset
  );
}

let handler = new WebPubSubEventHandler(hubName, {
  onConnected: (req: ConnectedRequest) => {
    let connId = req.context.connectionId;
    console.log(`${connId} connected`);
  },
  onDisconnected: (req: DisconnectedRequest) => {
    let connId = req.context.connectionId;
    console.log(`${connId} disconnected`);

    // TODO close conn
  },
  handleConnect: (req: ConnectRequest, res: ConnectResponseHandler) => {
    let connId = req.context.connectionId;
    let claims = req.claims;
    let roles = claims[ClaimTypeRole];

    doc.conns.set(connId, req.context);

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, messageSync);
    syncProtocol.writeSyncStep1(encoder, doc);
    var message = Arr2Buf(encoding.toUint8Array(encoder));
    console.log(connId, message);
    client.sendToConnection(connId, message);

    const awarenessStates = doc.awareness.getStates();
    if (awarenessStates.size > 0) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, messageAwareness);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
          doc.awareness,
          Array.from(awarenessStates.keys())
        )
      );
      client.sendToConnection(connId, Arr2Buf(encoding.toUint8Array(encoder)));
    }

    res.success();
  },
  handleUserEvent: (req: UserEventRequest, res: UserEventResponseHandler) => {
    let connId = req.context.connectionId;
    console.log(typeof req.data)

    let data = new Uint8Array();
    if (typeof req.data === "string") {
      let d = new TextEncoder()
      data = d.encode(req.data)
      console.log(data)
    }

    try {
      const encoder = encoding.createEncoder();
      const decoder = decoding.createDecoder(data);
      const messageType = decoding.readVarUint(decoder);
      switch (messageType) {
        case messageSync:
          encoding.writeVarUint(encoder, messageSync);
          syncProtocol.readSyncMessage(decoder, encoder, doc, null);
          if (encoding.length(encoder) > 1) {
            client.sendToConnection(connId, Arr2Buf(encoding.toUint8Array(encoder)))
          }
          break;
        case messageAwareness: {
          awarenessProtocol.applyAwarenessUpdate(
            doc.awareness,
            decoding.readVarUint8Array(decoder),
            connId,
          );
          break;
        }
      }
    } catch (err) {
      console.error(err);
      doc.emit("error", [err]);
    }

    res.success();
  },
});

app.use(handler.getMiddleware());
console.log(handler.path);

let corsOptions = {
  // origin: "https://newcodestrdev60af4ctab.z5.web.core.windows.net"
};

const corsMiddleware = cors(corsOptions);

app.options("/negotiate", corsMiddleware);

app.get(
  "/negotiate",
  aadJwtMiddleware,
  corsMiddleware,
  async (req: any, res: any) => {
    let group =
      req.query.id?.toString() || Math.random().toString(36).slice(2, 7);

    if (groupDict[group] == undefined) {
      groupDict[group] = new GroupContext(group);
    }
    console.log(groupDict);

    let roles = [
      `webpubsub.sendToGroup.${group}`,
      `webpubsub.joinLeaveGroup.${group}`,
    ];

    let userId: string =
      req.user ??
      req.claims?.name ??
      "Anonymous " + Math.floor(1000 + Math.random() * 9000);

    let token = await client.getClientAccessToken({
      userId: userId,
      roles: roles,
    });

    res.json({
      group: group,
      user: userId,
      url: token.url,
    });
  }
);

app.use(express.static("public"));
app.listen(8080, () => console.log("app started"));
