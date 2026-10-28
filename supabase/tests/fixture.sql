-- Isolated PostgreSQL fixture ONLY: this is not real Supabase Auth/JWT verification.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
INSERT INTO auth.users VALUES('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth,public TO anon,authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated;
CREATE FUNCTION public.test_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END $$;
CREATE FUNCTION public.test_denied(query text,label text,expected text DEFAULT '42501') RETURNS void LANGUAGE plpgsql AS $$ BEGIN BEGIN EXECUTE query; EXCEPTION WHEN OTHERS THEN IF SQLSTATE=expected THEN RAISE NOTICE 'PASS: % (%)',label,SQLSTATE;RETURN; END IF;RAISE;END;RAISE EXCEPTION 'FAIL (unexpected success): %',label;END $$;
GRANT EXECUTE ON FUNCTION public.test_assert(boolean,text),public.test_denied(text,text,text) TO anon,authenticated;
