<?php
// Real Moodle bootstrap, restricted to a fresh mprovi_test_* qualification DB.
define('CLI_SCRIPT', true);
$root = getenv('MOODLE_QA_ROOT');
if (!$root || !is_file($root . '/config.php')) {
    throw new RuntimeException('Isolated Moodle configuration required.');
}
require($root . '/config.php');
if ($CFG->dbname !== 'mprovi_test_moodle' || $CFG->wwwroot !== 'http://127.0.0.1:3458') {
    throw new RuntimeException('Qualification instance required.');
}
$manager = core_plugin_manager::instance();
foreach (['local_filesharing', 'tiny_filesharing', 'repository_filesharing'] as $component) {
    if (!$manager->get_plugin_info($component) || !get_config($component, 'version')) {
        throw new RuntimeException('Plugin not installed: ' . $component);
    }
}
$roleid = get_config('local_filesharing', 'contributorroleid');
if (!$roleid || !$DB->record_exists('role', ['id' => $roleid, 'shortname' => 'filesharingcontributor'])) {
    throw new RuntimeException('Contributor role missing.');
}
foreach (['viewicon', 'access', 'upload'] as $capability) {
    if (!$DB->record_exists('role_capabilities', ['roleid' => $roleid, 'capability' => 'local/filesharing:' . $capability, 'permission' => CAP_ALLOW])) {
        throw new RuntimeException('Contributor capability missing.');
    }
}
if ($DB->record_exists('role_assignments', ['roleid' => $roleid])) {
    throw new RuntimeException('Installation must not assign contributors automatically.');
}
require_once($CFG->dirroot . '/repository/filesharing/lib.php');
if (!is_subclass_of('repository_filesharing', 'repository') || !class_exists('\tiny_filesharing\plugininfo')) {
    throw new RuntimeException('Moodle plugin class contract failed.');
}
if (!class_exists('\local_filesharing\privacy\provider') || !class_exists('\local_filesharing\external\catalogue')) {
    throw new RuntimeException('Privacy/AJAX class contract failed.');
}
$repository = (new ReflectionClass('repository_filesharing'))->newInstanceWithoutConstructor();
if ($repository->supported_returntypes() !== FILE_EXTERNAL || $repository->default_returntype() !== FILE_EXTERNAL) {
    throw new RuntimeException('Repository must only offer external links.');
}
if (!$DB->record_exists('role_capabilities', ['roleid' => $roleid, 'capability' => 'repository/filesharing:view', 'permission' => CAP_ALLOW])) {
    throw new RuntimeException('Contributor repository capability missing.');
}
require_once($CFG->dirroot . '/user/lib.php');
$browserpassword = 'Qa-7' . bin2hex(random_bytes(24));
$id = user_create_user((object)['username' => 'qacontributor', 'auth' => 'manual', 'confirmed' => 1,
    'firstname' => 'Qualification', 'lastname' => 'Teacher', 'email' => 'teacher@example.invalid',
    'password' => $browserpassword], true, false);
$identity = local_filesharing\bridge::identity($id);
if (!$identity['active'] || $identity['capabilities']) {
    throw new RuntimeException('Ordinary account must have no management capability.');
}
role_assign($roleid, $id, context_system::instance()->id);
$identity = local_filesharing\bridge::identity($id);
foreach (['viewicon', 'access', 'upload'] as $capability) {
    if (!in_array($capability, $identity['capabilities'])) {
        throw new RuntimeException('System role not reflected by the bridge.');
    }
}
$DB->set_field('user', 'suspended', 1, ['id' => $id]);
if (local_filesharing\bridge::identity($id)['active']) {
    throw new RuntimeException('Suspended Moodle account accepted.');
}
$DB->set_field('user', 'suspended', 0, ['id' => $id]);
set_config('apporigin', 'http://127.0.0.1:5174', 'local_filesharing');
set_config('allowinsecure', 1, 'local_filesharing');
// The isolated PHP server and signed catalogue fixture use loopback HTTP only.
// These settings never run against the institution's Moodle (guard above).
set_config('cookiesecure', 0);
set_config('curlsecurityblockedhosts', '');
set_config('curlsecurityallowedport', '5174');
set_config('clientid', 'mprovifilesharing', 'local_filesharing');
set_config('keyid', 'v1', 'local_filesharing');
$secret = bin2hex(random_bytes(32));
set_config('sharedsecret', $secret, 'local_filesharing');
$catalogsecret = bin2hex(random_bytes(32));
set_config('catalogsecret', $catalogsecret, 'local_filesharing');
$encode = fn($bytes) => rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
$codes = [];
foreach (['valid', 'expired', 'proof'] as $case) {
    $code = $encode(random_bytes(32)); $verifier = $encode(random_bytes(32));
    $DB->insert_record('local_filesharing_code', (object)['codehash' => hash('sha256', $code), 'userid' => $id,
        'challenge' => $encode(hash('sha256', $verifier, true)), 'purpose' => 'manage', 'expires' => time() + ($case === 'expired' ? -1 : 60)]);
    $codes[$case] = ['code' => $code, 'verifier' => $verifier];
}
file_put_contents(dirname($root) . '/bridge-test.json', json_encode(['secret' => $secret, 'catalogSecret' => $catalogsecret,
    'browserPassword' => $browserpassword, 'resourceId' => '3d4de0d9-4037-456a-831d-f57bd60dbd5e',
    'subject' => (string)$id, 'codes' => $codes], JSON_THROW_ON_ERROR));
$report = json_encode(['status' => 'installed', 'moodle' => $CFG->release, 'plugins' => 3,
    'checks' => ['fresh install', 'system role without assignments', 'capabilities', 'ordinary and suspended accounts', 'FILE_EXTERNAL only', 'repository/Tiny/privacy/AJAX class contracts']], JSON_PRETTY_PRINT) . "\n";
if (getenv('MOODLE_QA_REPORT')) {
    file_put_contents(getenv('MOODLE_QA_REPORT'), $report);
}
echo $report;
