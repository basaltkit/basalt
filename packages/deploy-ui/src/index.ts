/**
 * @basaltkit/deploy-ui — a local UI for @basaltkit/deploy (RFC 0009). The
 * package is a program (`basalt-deploy-ui`); these exports are its building
 * blocks, for tests and for a wrapper that starts it differently.
 */
export { checkTarget, checkTargetsFile, defaultTargetsPath, readTargets, writeTargets, TargetsFileError, type Target, type TargetsFile } from './targets.js'
export { classifySshFailure, DEPLOY_BIN, remoteCommand, shQuote, sshArgs, sshProgram, SSH_OPTIONS, type RemoteSpec } from './ssh.js'
export { ProtocolReader, sanitizeText, MAX_LINE_BYTES } from './stream.js'
export { execRemote, follow, type SshRunner } from './remote.js'
export type { CommandReply, StreamMessage, TargetsReply } from './client/messages.js'
