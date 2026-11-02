<?php
// SPDX-License-Identifier: GPL-3.0-or-later
defined('MOODLE_INTERNAL') || die();
$tasks = [['classname' => '\local_filesharing\task\cleanup', 'blocking' => 0,
    'minute' => '*/5', 'hour' => '*', 'day' => '*', 'month' => '*', 'dayofweek' => '*']];
