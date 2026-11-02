<?php
// PHP/Node interoperability vector. No Moodle runtime or credentials required.
define('MOODLE_INTERNAL', true);
require_once(__DIR__ . '/../../moodle/local/filesharing/classes/bridge.php');
$body = '{"subject":"42","name":"école"}';
echo \local_filesharing\bridge::signature(hex2bin(str_repeat('f0', 32)), '/service', '1793650000', 'nonce', $body);
