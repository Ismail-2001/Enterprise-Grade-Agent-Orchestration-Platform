-- Migration 007: Down — remove dead letter queue table

DROP TABLE IF EXISTS dead_letter_queue;
