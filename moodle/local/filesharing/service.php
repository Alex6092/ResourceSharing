<?php
// SPDX-License-Identifier: GPL-3.0-or-later
define('NO_MOODLE_COOKIES', true);
define('NO_DEBUG_DISPLAY', true);
define('AJAX_SCRIPT', true);
require_once(__DIR__ . '/../../config.php');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function local_filesharing_reply(int $status, array $value): never {
    http_response_code($status);
    echo json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
try {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        local_filesharing_reply(405, ['code' => 'METHOD_NOT_ALLOWED']);
    }
    $raw = file_get_contents('php://input', false, null, 0, 65537);
    if (strlen($raw) > 65536) {
        local_filesharing_reply(413, ['code' => 'REQUEST_TOO_LARGE']);
    }
    $time = $_SERVER['HTTP_X_TIMESTAMP'] ?? '';
    $nonce = $_SERVER['HTTP_X_NONCE'] ?? '';
    $signature = $_SERVER['HTTP_X_SIGNATURE'] ?? '';
    if (($_SERVER['HTTP_X_CLIENT_ID'] ?? '') !== get_config('local_filesharing', 'clientid')
            || ($_SERVER['HTTP_X_KEY_ID'] ?? '') !== get_config('local_filesharing', 'keyid')
            || !preg_match('/^\d{10}$/D', $time) || abs(time() - (int)$time) > 60
            || !preg_match('/^[A-Za-z0-9_-]{43}$/D', $nonce) || !preg_match('/^[0-9a-f]{64}$/D', $signature)
            || !hash_equals(\local_filesharing\bridge::signature(\local_filesharing\bridge::secret('sharedsecret'),
                '/local/filesharing/service.php', $time, $nonce, $raw), $signature)) {
        local_filesharing_reply(401, ['code' => 'INVALID_SIGNATURE']);
    }
    try {
        $DB->insert_record('local_filesharing_nonce', (object)['nonce' => $nonce, 'expires' => time() + 300]);
    } catch (dml_write_exception $e) {
        if ($DB->record_exists('local_filesharing_nonce', ['nonce' => $nonce])) {
            local_filesharing_reply(401, ['code' => 'REPLAY']);
        }
        throw $e;
    }
    $body = json_decode($raw, true, 16, JSON_THROW_ON_ERROR);
    if (($body['action'] ?? '') === 'status') {
        if (!preg_match('/^[1-9]\d{0,14}$/D', (string)($body['subject'] ?? ''))) {
            local_filesharing_reply(400, ['code' => 'INVALID_SUBJECT']);
        }
        local_filesharing_reply(200, \local_filesharing\bridge::identity((int)$body['subject']));
    }
    if (($body['action'] ?? '') !== 'exchange' || !preg_match('/^[A-Za-z0-9_-]{43}$/D', (string)($body['code'] ?? ''))
            || !preg_match('/^[A-Za-z0-9_-]{43}$/D', (string)($body['verifier'] ?? ''))
            || ($body['clientId'] ?? '') !== get_config('local_filesharing', 'clientid')
            || ($body['redirectUri'] ?? '') !== \local_filesharing\bridge::app_origin() . '/auth/moodle/callback') {
        local_filesharing_reply(400, ['code' => 'SSO_DENIED']);
    }
    $hash = hash('sha256', $body['code']);
    $lock = \core\lock\lock_config::get_lock_factory('local_filesharing')->get_lock('sso_' . $hash, 10);
    if (!$lock) {
        local_filesharing_reply(503, ['code' => 'BUSY']);
    }
    // Ne pas appeler reply() dans ce bloc : exit ne déroule pas finally en PHP.
    $status = 403;
    $result = ['code' => 'CODE_USED'];
    try {
        $record = $DB->get_record('local_filesharing_code', ['codehash' => $hash]);
        if ($record) {
            if ($record->expires < time()) {
                $DB->delete_records('local_filesharing_code', ['id' => $record->id]);
                $result = ['code' => 'CODE_EXPIRED'];
            } else if (!hash_equals($record->challenge, rtrim(strtr(base64_encode(hash('sha256', $body['verifier'], true)), '+/', '-_'), '='))) {
                $result = ['code' => 'INVALID_PROOF'];
            } else {
                $DB->delete_records('local_filesharing_code', ['id' => $record->id]);
                $identity = \local_filesharing\bridge::identity((int)$record->userid);
                if ($identity['active'] && ($record->purpose !== 'manage' || in_array('access', $identity['capabilities']) || in_array('admin', $identity['capabilities']))) {
                    $status = 200;
                    $result = $identity;
                } else {
                    $result = ['code' => 'SSO_DENIED'];
                }
            }
        }
    } finally {
        $lock->release();
    }
    local_filesharing_reply($status, $result);
} catch (Throwable $e) {
    local_filesharing_reply(503, ['code' => 'SERVICE_UNAVAILABLE']);
}
