<?php
// SPDX-License-Identifier: GPL-3.0-or-later
defined('MOODLE_INTERNAL') || die();
$functions = ['local_filesharing_catalogue' => [
    'classname' => 'local_filesharing\external\catalogue', 'methodname' => 'execute',
    'description' => 'Search the external resource catalogue and select stable links.',
    'type' => 'write', 'ajax' => true, 'capabilities' => 'local/filesharing:access',
]];
