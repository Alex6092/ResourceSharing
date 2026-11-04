<?php
// Isolated test page only. Never installed as a production plugin or endpoint.
require(__DIR__ . '/config.php');
if ($CFG->dbname !== 'mprovi_test_moodle' || $CFG->wwwroot !== 'http://127.0.0.1:3458') {
    throw new RuntimeException('Qualification instance required.');
}
require_login();
require_once($CFG->libdir . '/editorlib.php');
$context = context_system::instance();
require_capability('local/filesharing:access', $context);
$PAGE->set_context($context);
$PAGE->set_url('/qa-filesharing-editor.php');
$PAGE->set_title('Filesharing editor qualification');
$PAGE->set_heading('Filesharing editor qualification');
editors_get_editor('tiny')->use_editor('qaeditor', ['context' => $context]);
echo $OUTPUT->header();
echo '<form><label for="qaeditor">Qualification editor</label><textarea id="qaeditor" name="qaeditor"><p>Existing content.</p></textarea></form>';
echo $OUTPUT->footer();
