import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createProjectIdFromPath } from './project-id.js';
import { OPENCODE_TRUST_REQUIRED } from '../opencode-trust/index.js';
import { isSpaceDirectory } from '../spaces/dispatcher.js';

const requestSchema = z.object({ sessionId: z.string().trim().min(1), directory: z.string().trim().min(1) });
const ownerRequestSchema = z.object({
  project: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
const contains = (root, directory) => {
  const relative = path.relative(root, directory);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

// A registered project on a hung mount must not hold the settings write queue.
const PROJECT_ASSESS_TIMEOUT_MS = 2000;

/** The root of the linked worktree holding `directory` (its `.git` is a pointer file), or null. */
const findLinkedWorktreeRoot = async (directory) => {
  for (let current = directory; ; current = path.dirname(current)) {
    const info = await fs.promises.lstat(path.join(current, '.git')).catch(() => null);
    if (info) return info.isFile() ? current : null;
    if (path.dirname(current) === current) return null;
  }
};

/**
 * Register one session destination without changing any window's selection.
 * The answer names the session's canonical folder: a session OpenCode recorded
 * under a symlinked spelling of that folder (`/tmp` for `/private/tmp`) is
 * moved there first, since clients match sessions to projects by that path.
 */
export const registerSessionProjectRoutes = (app, {
  validateDirectoryPath, openCodeTrust, registerSessionProject, resolveSessionDirectory, moveSession, emitWorktreeChanged,
  linkedWorktreeRoot = findLinkedWorktreeRoot,
}) => {
  // Workspace provisioning has no saved session yet. The owner signs the exact
  // complete policy and target using the existing native admission key. This
  // route neither assesses imported code nor changes its trust records.
  app.post('/api/projects/owner-directory', async (req, res) => {
    const helperPath = process.env.PEIRCE_ADMISSION_HELPERS;
    if (!helperPath) return res.status(404).json({ error: 'Workspace owner registration is unavailable' });
    const headers = req.headers;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
      || Object.keys(headers).some(key => ['origin', 'cookie', 'forwarded', 'x-openchamber-relay-connection'].includes(key)
        || key.startsWith('x-forwarded-') || key.startsWith('sec-fetch-'))) {
      return res.status(403).json({ error: 'Direct owner loopback request required' });
    }
    const parsed = ownerRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'One policy project and exact revision required' });
    const signature = headers['x-peirce-owner-proof'];
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
      return res.status(403).json({ error: 'Owner proof required' });
    }
    try {
      const helperURL = pathToFileURL(helperPath);
      const { loadPolicy } = await import(helperURL.href);
      const policyURL = new URL('../../runtime/policy.json', helperURL);
      const keyURL = new URL('../../runtime/admission-key', helperURL);
      const policy = await loadPolicy(policyURL);
      const key = (await fs.promises.readFile(keyURL, 'utf8')).trim();
      const hash = createHash('sha256').update(JSON.stringify(policy)).digest('hex');
      const expected = createHmac('sha256', key).update(JSON.stringify(['peirce-owner-project-v1', hash, parsed.data.project])).digest('hex');
      if (Buffer.byteLength(key) < 32 || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return res.status(403).json({ error: 'Owner proof refused' });
      }
      const directory = policy.projects[parsed.data.project]?.directory;
      if (policy.revision !== parsed.data.revision || !directory) return res.status(409).json({ error: 'Approved policy target changed' });
      const checkTarget = async () => {
        if (await fs.promises.realpath(directory) !== directory || !(await fs.promises.stat(directory)).isDirectory()
          || !isDeepStrictEqual(await loadPolicy(policyURL), policy)
          || (await fs.promises.readFile(keyURL, 'utf8')).trim() !== key) {
          throw Object.assign(new Error('Approved policy target changed'), { code: 'owner_target_changed' });
        }
      };
      let project;
      try {
        await checkTarget();
        project = await registerSessionProject(async (projects, current) => {
          await checkTarget();
          const raw = current.projects ?? [];
          if (raw.length !== projects.length || raw.some(entry => !entry || typeof entry.path !== 'string'
            || !path.isAbsolute(entry.path) || path.normalize(entry.path) !== entry.path
            || entry.id !== createProjectIdFromPath(entry.path))
            || new Set(raw.map(entry => entry.id)).size !== raw.length
            || new Set(raw.map(entry => entry.path)).size !== raw.length) {
            throw new Error('Native registry requires owner inspection');
          }
          const id = createProjectIdFromPath(directory);
          const existing = projects.find(entry => entry.id === id || entry.path === directory);
          if (existing && (existing.path !== directory || existing.id !== id)) {
            throw Object.assign(new Error('Conflicting native project binding'), { code: 'owner_target_changed' });
          }
          return existing ?? { id, path: directory, addedAt: Date.now() };
        });
      } catch (error) {
        if (error.code === 'owner_target_changed' || error.code === 'ENOENT') return res.status(409).json({ error: 'Approved policy target changed' });
        throw error;
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ project, revision: policy.revision });
    } catch {
      return res.status(503).json({ error: 'Owner project registration incomplete; inspect before retry' });
    }
  });

  app.post('/api/projects/session-directory', async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success || isSpaceDirectory(parsed.data.directory)) {
      return res.status(400).json({ error: 'A host session directory is required' });
    }
    try {
      const validated = await validateDirectoryPath(parsed.data.directory);
      if (!validated.ok) return res.status(400).json({ error: validated.error });
      const directory = validated.directory;
      const recorded = await resolveSessionDirectory(parsed.data.sessionId);
      const respelled = recorded !== directory;
      if (respelled && !(recorded && (await validateDirectoryPath(recorded)).directory === directory)) {
        return res.status(409).json({ error: 'The session directory changed' });
      }
      // Finish one-time trust seeding before acquiring the settings write queue.
      await openCodeTrust.assess(directory, { fresh: true });
      let worktreeOf = null;
      const project = await registerSessionProject(async (projects) => {
        // Check again at the write boundary: the configuration can change
        // between answering the dialog and registering the destination.
        const { assessment, trusted } = await openCodeTrust.assess(directory, { fresh: true });
        if (!trusted) throw Object.assign(new Error('Folder trust is required'), { code: OPENCODE_TRUST_REQUIRED });
        const existing = projects.filter((entry) => contains(entry.path, directory))
          .sort((left, right) => right.path.length - left.path.length)[0];
        if (existing) return existing;
        // A linked worktree lives outside its repository's folder. It belongs
        // to the project that registered the repository; the client may not
        // have listed it yet when a session moves into it. A folder beside a
        // registered project in the same checkout shares the repository but is
        // no worktree that project lists, so it registers as its own project.
        const worktreeRoot = assessment.repositoryKey === assessment.directory ? null : await linkedWorktreeRoot(directory);
        if (worktreeRoot) {
          for (const entry of projects) {
            if (contains(worktreeRoot, entry.path)) continue;
            const projectAssessment = await Promise.race([
              openCodeTrust.assess(entry.path).then(({ assessment: found }) => found, () => null),
              new Promise((resolve) => { setTimeout(resolve, PROJECT_ASSESS_TIMEOUT_MS, null).unref?.(); }),
            ]);
            if (projectAssessment?.repositoryKey === assessment.repositoryKey) {
              worktreeOf = entry;
              return entry;
            }
          }
        }
        return { id: createProjectIdFromPath(directory), path: directory, label: path.basename(directory) || directory, addedAt: Date.now(), lastOpenedAt: Date.now() };
      });
      if (respelled) {
        // A move made during registration wins; this one would undo it.
        if (await resolveSessionDirectory(parsed.data.sessionId) !== recorded) {
          return res.status(409).json({ error: 'The session directory changed' });
        }
        // A running session takes the move at its next step boundary.
        await moveSession(parsed.data.sessionId, directory);
      }
      // Clients list the new worktree under its project on this event.
      if (worktreeOf) emitWorktreeChanged?.({ directories: [worktreeOf.path, directory], at: Date.now() });
      return res.json({ project, directory });
    } catch (error) {
      if (error?.code === OPENCODE_TRUST_REQUIRED) {
        return res.status(403).json({ code: OPENCODE_TRUST_REQUIRED, directory: parsed.data.directory });
      }
      return res.status(503).json({ error: 'Session project could not be registered' });
    }
  });
};
