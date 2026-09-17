import {BulkGradeUpdater} from 'canvas-scripts';
import Grader, {stringify} from './Grader.js';
import fs from 'fs/promises';
import Zip from 'adm-zip';
import path from 'path';
import * as c from './ColorUtils.js';
import {FatalGraderError} from './Utils.js';

const canvasIdRegex = /^[^_]*?(?:_LATE|)_([0-9]+)/;

/**
 * @typedef AssignmentConfig
 * @property {boolean} [onlyCurrent] Only run the submission in the current_submission directory.
 * @property {string} [startScript] Default start script.
 * @property {boolean} [runStartScript] Execute the start script before testing.
 * @property {string[]} [requiredFiles] Required submission files.
 * @property {string[]} [requiredCollections] Required database collections.
 * @property {boolean} [checkPackage] Check package.json.
 * @property {boolean} [hasDatabase] Enable database grading.
 * @property {string} [connectionString] MongoDB connection string.
 * @property {boolean} [commentsAsFiles] Upload feedback as text files.
 */

/**
 * @typedef CanvasConfig
 * @property {string} apiKey Canvas API key.
 * @property {string|number} courseId Canvas course ID.
 * @property {string|number} assignmentId Canvas assignment ID.
 */

/**
 * Run the autograder.
 */
async function autoGrade(
  submissionsDir,
  GraderClass,
  assignmentConfig,
  canvasConfig
) {
  if (assignmentConfig?.onlyCurrent) {
    const grader = new GraderClass(assignmentConfig);

    try {
      const {grade, comments} = await grader.run();

      console.log('Score: ' + c.success(grade));
      console.log(c.error(comments));
    } catch (e) {
      await grader.cleanup();

      console.error(c.error('Could not automatically grade submission.'));

      console.error(c.error(e.stack));
    }

    return;
  }

  if (assignmentConfig.runStartScript && !assignmentConfig.startScript) {
    console.log(c.warning("Using default start script 'node app.js'"));
  }

  const canvas = canvasConfig
    ? await new BulkGradeUpdater().setParameters(
        canvasConfig.apiKey,
        canvasConfig.courseId,
        canvasConfig.assignmentId
      )
    : null;

  try {
    await fs.access(submissionsDir);
  } catch {
    throw new Error('Submissions directory is inaccessible or does not exist');
  }

  /*
   * Track the ZIP associated with each Canvas student.
   */
  const students = new Map();

  const subs = await fs.readdir(submissionsDir);

  const originalDir = process.cwd();

  const submissionsPath = path.resolve(originalDir, submissionsDir);

  /*
   * Grade each submission locally.
   */
  for (const sub of subs.filter((file) => file.endsWith('.zip'))) {
    const fileLoc = path.join(submissionsDir, sub);

    const subDir = path.join(
      'current_submission',
      sub.substring(0, sub.length - 4)
    );

    let grader = null;

    try {
      process.chdir(originalDir);

      console.log(`Grading ${c.info(sub)}...`);

      await fs.rm('current_submission', {
        recursive: true,
        force: true
      });

      const zip = new Zip(fileLoc);

      zip.extractAllTo(subDir);

      grader = new GraderClass(assignmentConfig);

      const {grade, comments} = await grader.run();

      console.log(`Done. Scored ${c.success(grade)}`);

      if (!canvas) {
        console.log(c.error(comments));
      } else {
        if (canvasIdRegex.test(sub)) {
          const studentId = canvasIdRegex.exec(sub)[1];

          /*
           * Avoid ambiguous submissions.
           */
          if (students.has(studentId)) {
            throw new Error(
              `Duplicate Canvas ID ${studentId} in ZIP files ` +
                `${students.get(studentId).filename} and ${sub}. ` +
                'Resolve duplicate submissions before archiving either ZIP.'
            );
          }

          canvas.addStudent(studentId, grade, comments);

          students.set(studentId, {
            author: grader.author,
            filename: sub
          });
        } else {
          console.error(
            c.error(
              'Failed to locate student canvas ID for submission. ' +
                'Upload comments manually:'
            )
          );

          console.log(c.error(comments || 'No comments.'));
        }
      }
    } catch (e) {
      await grader?.cleanup();

      if (e instanceof FatalGraderError) {
        console.error(
          c.error(
            'Encountered an error that would interfere ' +
              'with the grading of further submissions. ' +
              'Aborting grader at this point.'
          )
        );

        console.error(c.error(e.toString()));

        break;
      } else {
        console.error(c.error('Could not automatically grade submission.'));

        console.error(c.error(e.stack));
      }
    }

    console.log(c.warning('------------------------------'));
  }

  /*
   * Upload grades and archive verified submissions.
   */
  if (canvas && students.size) {
    process.chdir(originalDir);

    const uploadedDir = path.join(submissionsPath, 'uploaded');

    let archivedCount = 0;

    /*
     * Called only after Canvas verifies the
     * student's grade and feedback.
     *
     * UPDATED BEHAVIOR:
     *
     * If a ZIP with the same filename already
     * exists in uploaded/, replace it with
     * the newly graded ZIP.
     *
     * No separate delete operation is needed.
     */
    const archiveVerifiedStudent = async (studentId) => {
      const student = students.get(String(studentId));

      if (!student) {
        throw new Error(
          `No source ZIP is recorded for Canvas student ${studentId}.`
        );
      }

      const source = path.join(submissionsPath, student.filename);

      const destination = path.join(uploadedDir, student.filename);

      /*
       * Ensure the uploaded directory exists.
       */
      await fs.mkdir(uploadedDir, {
        recursive: true
      });

      /*
       * Check whether an archived ZIP already
       * exists, solely for console reporting.
       *
       * An existing ZIP is NOT an error.
       */
      let replacingExisting = false;

      try {
        const existing = await fs.stat(destination);

        if (!existing.isFile()) {
          throw new Error(
            `Archive destination exists but is not a file: ${destination}`
          );
        }

        replacingExisting = true;
      } catch (e) {
        if (e.code !== 'ENOENT') {
          throw e;
        }
      }

      /*
       * Move the verified ZIP.
       *
       * On the same filesystem, fs.rename()
       * replaces an existing destination file.
       *
       * Do not delete the old ZIP first.
       */
      await fs.rename(source, destination);

      archivedCount++;

      if (replacingExisting) {
        console.log(c.success(`  REPLACED: ${student.filename} -> uploaded/`));
      } else {
        console.log(c.success(`  ARCHIVED: ${student.filename} -> uploaded/`));
      }
    };

    /*
     * Upload each student's grade and feedback.
     *
     * The Canvas integration continues past
     * individual failures and invokes the
     * archive callback only after verification.
     */
    try {
      const result = await canvas.sendUpdate(
        assignmentConfig?.commentsAsFiles,
        archiveVerifiedStudent
      );

      console.log(
        c.success(`Verified and archived ${archivedCount} submission(s).`)
      );

      /*
       * Individual failures are warnings.
       *
       * Their ZIP files remain in submissions/.
       */
      if (result?.failed) {
        console.warn(
          c.warning(
            `${result.failed} submission(s) need CA attention ` +
              'and remain in submissions/.'
          )
        );
      }
    } catch (e) {
      console.error(
        c.error(
          `${archivedCount} verified submission(s) were archived. ` +
            'Any submissions that failed are still in the submissions folder.'
        )
      );

      throw e;
    }
  } else {
    console.log(c.warning('No grades uploaded.'));
  }
}

export {autoGrade, Grader, stringify};
