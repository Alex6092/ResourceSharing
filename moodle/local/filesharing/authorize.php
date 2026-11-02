<?php
// SPDX-License-Identifier: GPL-3.0-or-later
require_once(__DIR__ . '/../../config.php');
require_login();
if (isguestuser()) {
    throw new moodle_exception('noguest');
}
$PAGE->set_context(context_system::instance());
$PAGE->set_url('/local/filesharing/authorize.php');
$client = required_param('client_id', PARAM_ALPHANUMEXT);
$redirect = required_param('redirect_uri', PARAM_URL);
$state = required_param('state', PARAM_RAW_TRIMMED);
$challenge = required_param('code_challenge', PARAM_RAW_TRIMMED);
$method = required_param('code_challenge_method', PARAM_ALPHANUM);
$purpose = required_param('purpose', PARAM_ALPHA);
$origin = \local_filesharing\bridge::app_origin();
\local_filesharing\bridge::secret('sharedsecret');
if ($client !== get_config('local_filesharing', 'clientid') || $redirect !== $origin . '/auth/moodle/callback'
        || !preg_match('/^[A-Za-z0-9_-]{43}$/D', $state) || !preg_match('/^[A-Za-z0-9_-]{43}$/D', $challenge)
        || $method !== 'S256' || !in_array($purpose, ['manage', 'download'])) {
    throw new invalid_parameter_exception('Invalid SSO request.');
}
if ($purpose === 'manage') {
    require_capability('local/filesharing:access', context_system::instance());
}
$identity = \local_filesharing\bridge::identity((int)$USER->id);
if (!$identity['active']) {
    throw new moodle_exception('nopermissions', 'error', '', 'filesharing');
}
$DB->delete_records_select('local_filesharing_code', 'expires < :now', ['now' => time()]);
if ($DB->count_records('local_filesharing_code', ['userid' => $USER->id]) >= 10) {
    throw new moodle_exception('toomanylogins', 'local_filesharing');
}
$code = rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
$DB->insert_record('local_filesharing_code', (object)['codehash' => hash('sha256', $code), 'userid' => $USER->id,
    'challenge' => $challenge, 'purpose' => $purpose, 'expires' => time() + 60]);
header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
redirect(new moodle_url($redirect, ['code' => $code, 'state' => $state]));
