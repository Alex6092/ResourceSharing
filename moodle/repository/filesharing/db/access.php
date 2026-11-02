<?php
// SPDX-License-Identifier: GPL-3.0-or-later
defined('MOODLE_INTERNAL') || die();
$capabilities = ['repository/filesharing:view' => ['captype' => 'read', 'contextlevel' => CONTEXT_SYSTEM,
    'archetypes' => ['manager' => CAP_ALLOW]]];
